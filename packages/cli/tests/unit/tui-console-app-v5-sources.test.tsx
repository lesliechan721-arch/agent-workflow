import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import {
  ConsoleAppV4,
  resolveConsoleV4ScreenId,
  type ConsoleV4ScreenId,
} from '../../src/tui/console-app-v4.js';
import {
  TuiController,
  type OperationEvidence,
  type OperationIntent,
} from '../../src/tui/controller.js';
import { CatalogProviderCompatibilityError } from '../../src/utils/catalog-public-error.js';
import { attachSafeOperationError } from '../../src/utils/safe-operation-diagnostic.js';

vi.mock('../../src/tui/clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import {
  configPage,
  controller,
  deferred,
  evidence,
  evidenceForIntent,
  loadResult,
} from '../helpers/tui-console-app-fixture.js';

import {
  acceptanceTraceStep,
  confirmReview,
  escape,
  focusAction,
  focusBottomAction,
  input,
  nextTurn,
  type AcceptanceTraceStep,
  writeAcceptanceTrace,
} from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

async function chooseSourceSave(
  instance: ReturnType<typeof render>,
  value: TuiController,
  action: 'only' | 'enable',
): Promise<void> {
  expect(value.snapshot.router.current.route.name).toBe('review');
  if (action === 'enable') {
    await focusAction(instance, '改为保存并启用');
    await input(instance, '\r');
  }

  await nextTurn(3);
  expect(value.snapshot.router.current.route.name).toBe('review');
}

describe('ConsoleAppV4', () => {
  it('keeps Catalog authoring out of the source list and runs the all-source check', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'sourceList' });
    const checkAll = vi.spyOn(value, 'recheckAllCatalogSources').mockResolvedValue();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).not.toContain('目录管理');

    await focusBottomAction(instance, '检查全部来源');
    await input(instance, '\r');
    expect(checkAll).toHaveBeenCalledTimes(1);
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceList' });
    instance.unmount();
  });

  it.each(['add', 'update'] as const)('renders real feed phase changes and bounded technical messages for source %s', async (sourceAction) => {
    const execution = deferred<unknown>();
    const progress = createRebuildProgressFeed();
    const value = new TuiController({
      ...controller().dependencies,
      captureEvidence: vi.fn().mockResolvedValue({
        catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:candidate' },
        sourceWrite: {
          configDigest: 'sha256:before', proposedConfigDigest: 'sha256:candidate',
          inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true,
        },
      }),
      executeIntent: vi.fn(() => execution.promise),
    }, progress);
    await value.load();
    const review = await value.buildOperationReview(sourceAction === 'add'
      ? {
          kind: 'sourceMutation', action: 'add', sourceId: 'new-source',
          source: { id: 'new-source', type: 'path', primary: false, path: '/fixture/catalog' },
        }
      : {
          kind: 'sourceMutation', action: 'update', sourceId: 'team-tools',
          update: { type: 'path', path: '/fixture/catalog' },
        });
    const running = value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    expect(instance.lastFrame()).not.toContain('d 技术进度');
    expect(instance.lastFrame()).toContain('? 帮助');
    await input(instance, '?');
    expect(instance.lastFrame()).toContain('当前页快捷键');
    expect(instance.lastFrame()).toMatch(/q \/ Ctrl-C\s+操作完成后退出/u);
    expect(instance.lastFrame()).not.toMatch(/d\s+(?:技术进度|技术详情)/u);
    await input(instance, '?');
    expect(instance.lastFrame()).not.toContain('当前页快捷键');

    progress.addEvent({
      type: 'rebuild:action',
      source: { plugin: 'safe-plugin', platform: 'codex', scope: 'user' },
      data: { name: 'preflight.inspect', phase: 'start' },
    });
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('检查当前组件');
    expect(instance.lastFrame()).toContain('safe-plugin · Codex/当前用户');

    progress.addEvent({
      type: 'rebuild:action',
      source: { plugin: 'safe-plugin', platform: 'codex', scope: 'user' },
      data: { name: 'native.write', phase: 'start' },
    });
    for (let index = 0; index < 7; index += 1) {
    progress.addNotice({ level: 'warning', identity: `warning-${index}`, message: '/private/raw-error' });
    }
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('d 技术进度');
    expect(instance.lastFrame()).toContain('? 帮助');
    await input(instance, 'd');
    const technical = instance.lastFrame() ?? '';
    expect(technical).toContain('写入平台插件');
    expect(technical.match(/收到警告/g)).toHaveLength(4);
    expect(technical).not.toContain('/private/raw-error');
    expect(technical.split('\n').length).toBeLessThanOrEqual(18);

    execution.resolve({ targetResults: [] });
    await running;
  });

  it('keeps the last direct source actions visible with HelpBar at 60x18', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    for (const label of ['移除来源', '更多操作']) {
      await focusAction(instance, label);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 选择动作');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(18);
    }
  });

  it.each([
    ['主来源', false, 80, 24, '主来源不能直接移除'],
    ['主来源', false, 60, 18, '主来源不能直接移除'],
    ['唯一来源', true, 80, 24, '至少保留一个来源'],
    ['唯一来源', true, 60, 18, '至少保留一个来源'],
  ] as const)('keeps each source removal reason within the available row budget', async (
    _state, unique, columns, rows, reason,
  ) => {
    const loaded = loadResult();
    if (unique) {
      loaded.payload.catalog.sources = loaded.payload.catalog.sources.filter((source) => source.id === 'official');
      loaded.configuredSources = loaded.configuredSources?.filter((source) => source.id === 'official');
      loaded.sourceDetails = loaded.sourceDetails?.filter((source) => source.id === 'official');
      loaded.catalogGenerations = loaded.catalogGenerations?.filter((generation) => generation.sourceId === 'official');
    }
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'sourceDetail', sourceId: 'official' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);

    await focusAction(instance, '移除来源');
    expect(instance.lastFrame()).toContain('› 移除来源');
    expect(instance.lastFrame()).toContain(reason);
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
  });

  it('uses the light source check for r without opening a second check action', async () => {
    const value = controller();
    await value.load();
    const recheck = vi.spyOn(value, 'recheckCatalogSource').mockResolvedValue(undefined);
    const fullValidate = vi.spyOn(value, 'fullValidateCatalogSource');
    const reload = vi.spyOn(value, 'reloadCatalog');
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('检查来源');
    await input(instance, 'r');

    expect(recheck).toHaveBeenCalledWith('team-tools');
    expect(fullValidate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it.each([[80, 24], [60, 18]] as const)(
    'prioritizes source plugins after a current check and shows short ref and relative time at %ix%i',
    async (columns, rows) => {
      const loaded = loadResult();
      loaded.sourceDetails = loaded.sourceDetails?.map((detail) =>
        detail.id === 'team-tools' ? { ...detail, autoCheck: false } : detail);
      const value = controller({
        loadStatus: vi.fn().mockResolvedValue(loaded),
        now: () => Date.now(),
        probeCatalogFreshness: vi.fn(async (sourceId: string) => ({
          sourceId,
          state: 'current' as const,
          activeVersion: '2.4.0',
          activeResolvedCommit: 'abc123',
        })),
      });
      await value.load();
      await value.recheckCatalogSource('team-tools');
      value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);

      let detail = instance.lastFrame() ?? '';
      for (let index = 0; index < 12 && (instance.lastFrame() ?? '').includes('↓ 后面还有信息'); index += 1) {
        await input(instance, '\u001B[B');
        detail += `\n${instance.lastFrame() ?? ''}`;
      }
      expect(detail).toContain('固定 ref · catalog/stable');
      expect(detail).toContain('本次检查 当前已是最新');
      expect(detail).toContain('检查时间 刚刚');
      await input(instance, 'a');
      expect(instance.lastFrame()).toContain('› 查看此来源插件');
      expect(detail).not.toContain('强制重新取得');

      value.replace({ name: 'sourceList' });
      await nextTurn(2);
      if (!(instance.lastFrame() ?? '').includes('固定 catalog/stable')) {
        await input(instance, '\u001B[B');
      }
      const list = instance.lastFrame() ?? '';
      expect(list).toContain('固定 catalog/stable');
      expect(list).toContain('刚刚');
      instance.unmount();
    },
  );

  it.each([
    [80, 24],
    [60, 18],
  ] as const)('keeps all source detail actions reachable at %ix%i and opens the focused technical route', async (columns, rows) => {
    const value = controller();
    await value.load();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);
    let facts = instance.lastFrame() ?? '';
    for (let index = 0; index < 12 && (instance.lastFrame() ?? '').includes('↓ 后面还有信息'); index += 1) {
      await input(instance, '\u001B[B');
      facts += `\n${instance.lastFrame() ?? ''}`;
    }
    expect(facts).not.toContain('远端 Catalog 检查失败');
    expect(facts).toContain('来源可用');
    expect(facts).toContain('当前目录 2.4.0');
    expect(facts).toContain('版本策略 固定 ref · catalog/stable');
    expect(facts).toContain('本次检查 尚未检查');
    expect(facts).toContain('检查时间 尚未检查');
    await input(instance, 'a');
    expect(instance.lastFrame()).toMatch(/› 检查来源 +\[r\]/u);

    for (const label of ['检查来源', '查看此来源插件', '来源设置', '移除来源', '更多操作']) {
      await focusAction(instance, label);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 选择动作');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    }

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceMore', sourceId: 'team-tools' });
    for (const label of ['设为主来源', '检查来源', '技术详情']) {
      await focusAction(instance, label);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    }
    await focusAction(instance, '技术详情');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceTechnical', sourceId: 'team-tools' });
  });

  it('shows no-Active recovery and redacts every unavailable-source technical field', async () => {
    const privateFailure = 'native stderr Authorization: Bearer bearer-secret '
      + 'https://alice:url-secret@example.test/catalog?access_token=query-secret '
      + '/Users/private-user /workspace/private /tmp/private /private/source/root';
    const unavailableLoad = loadResult();
    unavailableLoad.payload.catalog.sources = unavailableLoad.payload.catalog.sources.map((source) =>
      source.id === 'research' ? {
        ...source,
        type: 'git' as const,
        requestedRef: 'https://alice:url-secret@example.test/catalog?access_token=query-secret',
        error: privateFailure,
        errorCode: 'catalogSourceUnavailable',
      } : source);
    unavailableLoad.sourceDetails = unavailableLoad.sourceDetails?.map((source) =>
      source.id === 'research' ? {
        ...source,
        type: 'git' as const,
        requestedRef: 'catalog/stable',
        resolvedCommit: 'Authorization: Bearer commit-secret',
        locationSummary: 'Git 仓库位置已隐藏',
        errorCode: 'catalogSourceUnavailable',
      } : source);
    const unavailable = controller({ loadStatus: vi.fn().mockResolvedValue(unavailableLoad) });
    await unavailable.load();
    unavailable.push({ name: 'sourceDetail', sourceId: 'research' });
    const unavailableInstance = render(<ConsoleAppV4 controller={unavailable} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    const unavailableDefault = unavailableInstance.lastFrame() ?? '';
    expect(unavailableDefault).toContain('来源没有可用的启用版本');
    expect(unavailableDefault).toContain('恢复来源');
    expect(unavailableDefault).not.toContain('aw catalog source sync research');
    expect(unavailableDefault).not.toContain('catalogSourceUnavailable');
    for (const privateText of ['native stderr', 'bearer-secret', 'alice', 'url-secret', 'query-secret',
      '/Users/private-user', '/workspace/private', '/tmp/private', '/private/source/root']) {
      expect(unavailableDefault).not.toContain(privateText);
    }
    await focusAction(unavailableInstance, '更多操作');
    await input(unavailableInstance, '\r');
    await focusAction(unavailableInstance, '技术详情');
    await input(unavailableInstance, '\r');
    expect(unavailable.snapshot.router.current.route).toEqual({ name: 'sourceTechnical', sourceId: 'research' });
    let unavailableTechnical = unavailableInstance.lastFrame() ?? '';
    for (let page = 0; page < 20; page += 1) {
      await input(unavailableInstance, '\u001B[C');
      unavailableTechnical += `\n${unavailableInstance.lastFrame() ?? ''}`;
    }
    expect(unavailableTechnical).toContain('catalogGenerationUnavailable');
    expect(unavailableTechnical).toContain('resolve-source');
    expect(unavailableTechnical).not.toContain('last good');
    expect(unavailableTechnical).not.toContain('sha256:');
    for (const privateText of ['native stderr', 'Authorization', 'Bearer', 'bearer-secret', 'alice', 'url-secret', 'query-secret',
      '/Users/private-user', '/workspace/private', '/tmp/private', '/private/source/root', 'commit-secret']) {
      expect(unavailableTechnical).not.toContain(privateText);
    }
    await escape(unavailableInstance);
    expect(unavailable.snapshot.router.current.route).toEqual({ name: 'sourceMore', sourceId: 'research' });
  });

  it('opens source editing from the unavailable source issue edit action', async () => {
    const value = controller();
    await value.load();
    const issue = value.listUserIssues().find((candidate) => candidate.category === 'sourceUnavailable')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('› 编辑来源');
    await input(instance, '\r');

    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceEdit', sourceId: 'research' });
  });

  it.each([
    { columns: 80, rows: 24 },
    { columns: 60, rows: 18 },
  ])('keeps source 10 visible and opens its exact identity at $columns x $rows', async (size) => {
    const data = loadResult();
    data.payload.catalog.sources = Array.from({ length: 10 }, (_, index) => ({
      id: `source-${String(index + 1).padStart(2, '0')}`,
      identity: `identity:source-${index + 1}`,
      type: 'path' as const,
      primary: index === 0,
      requestedRef: 'path',
      freshness: 'active' as const,
    }));
    data.sourceDetails = data.payload.catalog.sources.map((source) => ({
      id: source.id,
      type: source.type,
      primary: source.primary,
      locationSummary: `已选择本地目录（${source.id}）`,
      pluginCount: 0,
      sourceIdentity: source.identity,
      requestedRef: source.requestedRef,
      freshness: source.freshness,
      configDigest: 'sha256:config',
    }));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    await value.load();
    value.push({ name: 'sourceList' });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(2);
    await input(instance, ...Array.from({ length: 9 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('› source-10');
    expect(instance.lastFrame()).not.toContain('source-01');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'source-10' });
  });

  it('masks absolute source paths in input frames while preserving editing', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'sourceList' });
    const source = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await focusBottomAction(source, '＋ 添加来源');
    await input(source, '\r', '\u001B[B', '\r', ...'private-source'.split(''), '\r');
    const privateSourcePath = '/Users/alice/private/catalog';
    await input(source, ...privateSourcePath.split(''));
    expect(source.lastFrame()).toContain('已选择 / … / catalog');
    expect(source.lastFrame()).not.toContain('/Users/alice/private');
    expect(source.lastFrame()).toContain('已隐藏父目录');
  });

  it('reaches S01-S13 through the real Git wizard and treats b as input text', async () => {
    const screens = new Set<ConsoleV4ScreenId>();
    const executeIntent = vi.fn().mockResolvedValue({ ok: true });
    const loaded = loadResult();
    loaded.cliChannel = 'beta';
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), executeIntent });
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 60, rows: 18 }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await nextTurn(5);
    await input(instance, '\u001B[B', '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('单个来源失败不会阻止其他来源继续工作');
    expect(screens).toContain('S01');
    await focusBottomAction(instance, '＋ 添加来源');
    await input(instance, '\r', '\r');
    expect(screens).toContain('S05');
    await input(instance, 'team-b2', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'sourceAdd', step: 'location' });
    await input(instance, 'https://example.test/catalog.git', '\r');
    expect(instance.lastFrame()).toContain('自动选择：当前 AW 使用预览版目录');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    expect(screens).toContain('S08');
    await input(instance, 'catalog/stable', '\r', 'catalog', '\r');
    await nextTurn(3);
    expect(screens).toContain('S14');
    await focusAction(instance, '查看修改汇总');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(instance.lastFrame()).toContain('team-b2');
    expect(instance.lastFrame()).not.toContain('Catalog 版本');
    expect(instance.lastFrame()).not.toContain('resolvedCommit');
    await chooseSourceSave(instance, value, 'enable');
    await confirmReview(instance, value);
    await nextTurn(5);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'catalogGeneration',
      action: 'activate',
      sourceId: 'team-b2',
    }), expect.anything(), expect.any(AbortSignal));
    expect(screens).toContain('S12');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    expect(value.snapshot.router).toMatchObject({
      depth: 3,
      current: { route: { name: 'result' } },
    });

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(value.snapshot.router).toMatchObject({
      depth: 2,
      current: { route: { name: 'sourceList' } },
    });
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(value.snapshot.router).toMatchObject({
      depth: 1,
      current: { route: { name: 'home' } },
    });
  });

  it('keeps h, H, q, and b as characters in a source field', async () => {
    const value = controller();
    const onSessionNavigation = vi.fn().mockResolvedValue('completed');
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onSessionNavigation={onSessionNavigation}
    />);
    await nextTurn(4);
    await input(instance, '\u001B[B', '\u001B[B', '\r');
    await focusBottomAction(instance, '＋ 添加来源');
    await input(instance, '\r', '\r');
    await input(instance, 'hHqb');

    expect(instance.lastFrame()).toContain('hHqb');
    expect(onSessionNavigation).not.toHaveBeenCalled();
    expect(value.hasSessionDraft).toBe(true);
  });

  it('discards the complete add-source route segment from S07 and returns to the source list', async () => {
    const value = controller();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\u001B[B', '\u001B[B', '\r');
    await focusBottomAction(instance, '＋ 添加来源');
    await input(instance, '\r', '\r');
    await input(instance, 'discard-me', '\r', 'https://example.test/catalog.git', '\r');
    expect(resolveConsoleV4ScreenId(value.snapshot, value)).toBe('S07');

    await input(instance, 'b', '\u001B[B', '\r');

    expect(value.snapshot.router).toMatchObject({
      depth: 2,
      current: { route: { name: 'sourceList' } },
    });
    expect(value.snapshot.activeReview).toBeUndefined();
    value.back();
    expect(value.snapshot.router.current.route).toEqual({ name: 'home' });
  });

  it('discards an add-source draft from its unified parent but q confirmation still exits', async () => {
    const exit = vi.fn();
    const value = controller();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(4);
    await input(instance, '\u001B[B', '\u001B[B', '\r');
    await focusBottomAction(instance, '＋ 添加来源');
    await input(instance, '\r', '\r');
    await input(instance, 'review-draft', '\r', 'https://example.test/catalog.git', '\r', '\r', '\r');
    await nextTurn(3);
    expect(resolveConsoleV4ScreenId(value.snapshot, value)).toBe('S14');

    await input(instance, 'q', '\u001B[B', '\r');

    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
  });

  it('backs from an edit-source Review to the source save summary', async () => {
    const value = controller();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    value.push({ name: 'sourceEdit', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\r');
    await nextTurn(4);
    await input(instance, ...Array.from({ length: 'https://example.test/team.git'.length }, () => '\u007F'), 'https://example.test/team-v2.git');
    expect(instance.lastFrame()).toContain('team-v2.git');
    await input(instance, '\r');
    await input(instance, ...Array.from({ length: 4 }, () => '\u001B[B'), '\r');
    await chooseSourceSave(instance, value, 'enable');
    expect(resolveConsoleV4ScreenId(value.snapshot, value)).toBe('S15');

    await input(instance, 'b');

    expect(value.snapshot.router).toMatchObject({
      current: { route: { name: 'sourceEdit' } },
    });
    expect(value.snapshot.activeReview).toBeUndefined();
  });

  it('saves a changed path source when the private path display has the same basename', async () => {
    const loaded = loadResult();
    const official = loaded.configuredSources.find((source) => source.id === 'official');
    if (!official || official.type !== 'path') throw new Error('expected path source fixture');
    official.path = '/a/catalog';
    const captureEvidence = vi.fn(async (intent: OperationIntent) => evidenceForIntent(intent));
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
    });
    await value.load();
    value.push({ name: 'sourceEdit', sourceId: 'official' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\r');
    await nextTurn(4);
    await input(instance, ...Array.from({ length: '/a/catalog'.length }, () => '\u007F'), '/b/catalog');
    expect(instance.lastFrame()).toContain('已选择 / … / catalog');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('sourceEdit');
    expect(instance.lastFrame()).toContain('1 项未保存');
    await input(instance, '\u001B[B', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('review');
    await chooseSourceSave(instance, value, 'only');

    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'sourceMutation',
      action: 'update',
      sourceId: 'official',
      update: expect.objectContaining({ type: 'path', path: '/b/catalog' }),
    }), expect.any(AbortSignal));
  });

  it('drops an unchanged edit-source draft before returning home', async () => {
    const value = controller();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\r', '\u001B', 'h');

    expect(value.snapshot.router.current.route.name).not.toBe('sourceEdit');
    expect(value.hasSessionDraft).toBe(false);
    expect(instance.lastFrame()).not.toContain('放弃未保存修改？');
  });

  it('[source-edit/official/https] reviews an official HTTPS to SSH transport switch before any source write', async () => {
    const loaded = loadResult();
    loaded.payload.catalog.sources[0] = {
      id: 'official',
      identity: 'identity:official-workspace',
      type: 'git',
      primary: true,
      requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit: 'abc123',
      freshness: 'active',
    };
    loaded.configuredSources![0] = {
      id: 'official',
      type: 'git',
      primary: true,
      url: 'https://github.com/lesliechan721-arch/agent-workflow.git',
      refPolicy: { type: 'cliChannel' },
      autoCheck: true,
    };
    loaded.sourceDetails![0] = {
      id: 'official',
      type: 'git',
      primary: true,
      locationSummary: 'https://github.com/lesliechan721-arch/agent-workflow.git',
      refPolicy: 'cliChannel',
      pluginCount: 2,
      sourceIdentity: 'identity:official-workspace',
      requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit: 'abc123',
      freshness: 'active',
      configDigest: 'sha256:config',
    };
    const executeIntent = vi.fn().mockResolvedValue({ ok: true });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), executeIntent });
    value.push({ name: 'sourceEdit', sourceId: 'official' });
    const standardSize = { columns: 80, rows: 24 };
    const compactSize = { columns: 60, rows: 18 };
    const instance = render(<ConsoleAppV4 controller={value} size={standardSize} />);
    const trace: AcceptanceTraceStep[] = [];
    await nextTurn(5);

    expect(instance.lastFrame()).toContain('下载方式');
    expect(instance.lastFrame()).toContain('HTTPS');
    expect(instance.lastFrame()).not.toContain('○ SSH');
    trace.push(acceptanceTraceStep(instance, standardSize, '官方下载方式草稿', []));
    await input(instance, '\r', '\u001B[B');
    expect(instance.lastFrame()).toContain('当前草稿：HTTPS');
    expect(instance.lastFrame()).toContain('● HTTPS');
    expect(instance.lastFrame()).toContain('› ○ SSH');
    expect(instance.lastFrame()).toContain('适合已配置 GitHub SSH 访问的用户');
    trace.push(acceptanceTraceStep(instance, standardSize, '打开局部选择并聚焦 SSH', ['Enter', 'ArrowDown']));
    instance.rerender(<ConsoleAppV4 controller={value} size={compactSize} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('默认方式；无需预先配置 SSH 密钥');
    expect(instance.lastFrame()).toContain('适合已配置 GitHub SSH 访问的用户');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    trace.push(acceptanceTraceStep(instance, compactSize, '缩窄后选择说明完整', ['resize 60x18']));
    instance.rerender(<ConsoleAppV4 controller={value} size={standardSize} />);
    await nextTurn(2);
    await escape(instance);
    expect(instance.lastFrame()).toContain('HTTPS');
    expect(instance.lastFrame()).not.toContain('○ SSH');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    await input(instance, '\r', '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('SSH');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('当前草稿：SSH');
    expect(instance.lastFrame()).toContain('○ HTTPS');
    expect(instance.lastFrame()).toContain('› ● SSH');
    trace.push(acceptanceTraceStep(instance, standardSize, '取消不改草稿，确认后再次打开显示 SSH 当前值', ['resize 80x24', 'Esc', 'Enter', 'ArrowDown', 'Enter', 'Enter']));
    await escape(instance);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(executeIntent).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('Git 仓库地址');
    expect(instance.lastFrame()).not.toContain('http://');
    trace.push(acceptanceTraceStep(instance, standardSize, '进入 Review 且尚未执行写入', ['ArrowDown × 4', 'Enter', 'Enter']));
    await writeAcceptanceTrace('source-edit/official/https', trace);
  });

  it.each([
    { key: 'q', expected: 'exit' },
    { key: '\u0003', expected: 'exit' },
    { key: 'h', expected: 'home' },
    { key: 'H', expected: 'reload' },
  ] as const)('routes $key from the transport picker through the parent draft guard', async ({ key, expected }) => {
    const loaded = loadResult();
    loaded.payload.catalog.sources[0] = {
      id: 'official', identity: 'identity:official-workspace', type: 'git', primary: true,
      requestedRef: 'refs/heads/catalog/latest', resolvedCommit: 'abc123', freshness: 'active',
    };
    loaded.configuredSources![0] = {
      id: 'official', type: 'git', primary: true,
      url: 'https://github.com/lesliechan721-arch/agent-workflow.git',
      refPolicy: { type: 'cliChannel' }, autoCheck: true,
    };
    const navigate = vi.fn().mockResolvedValue('draftBlocked');
    const exit = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    value.push({ name: 'sourceEdit', sourceId: 'official' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }}
      onExit={exit} onSessionNavigation={navigate} />);
    await nextTurn(4);

    await input(instance, '\r', '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('SSH');
    expect(value.hasSessionDraft).toBe(true);
    await input(instance, '\r', key);
    await nextTurn(3);

    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    expect(value.snapshot.router.current.route.name).toBe('sourceEdit');
    expect(value.hasSessionDraft).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    if (expected === 'exit') expect(navigate).not.toHaveBeenCalled();
    else expect(navigate).toHaveBeenCalledWith(expected, { discardDrafts: false });

    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('SSH');
    expect(value.hasSessionDraft).toBe(true);
  });

  it.each(['q', '\u0003'] as const)(
    'asks for an ordinary exit from a clean transport picker with %s',
    async (key) => {
      const loaded = loadResult();
      loaded.configuredSources![0] = {
        id: 'official', type: 'git', primary: true,
        url: 'https://github.com/lesliechan721-arch/agent-workflow.git',
        refPolicy: { type: 'cliChannel' }, autoCheck: true,
      };
      const exit = vi.fn();
      const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
      value.push({ name: 'sourceEdit', sourceId: 'official' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
      await nextTurn(4);

      await input(instance, '\r', key);

      expect(instance.lastFrame()).toContain('退出控制台？');
      expect(instance.lastFrame()).not.toContain('放弃未保存修改？');
      expect(value.snapshot.router.current.route.name).toBe('sourceEdit');
      expect(exit).not.toHaveBeenCalled();
    },
  );

  it('keeps a custom official mirror as an editable address', async () => {
    const loaded = loadResult();
    loaded.configuredSources![0] = {
      id: 'official', type: 'git', primary: true,
      url: 'https://mirror.example.test/catalog.git',
      refPolicy: { type: 'cliChannel' }, autoCheck: true,
    };
    loaded.sourceDetails![0] = {
      ...loaded.sourceDetails![0]!, type: 'git',
      locationSummary: 'https://mirror.example.test/catalog.git',
      refPolicy: 'cliChannel',
    };
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    value.push({ name: 'sourceEdit', sourceId: 'official' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    expect(instance.lastFrame()).toContain('Git 仓库地址');
    expect(instance.lastFrame()).toContain('mirror.example.test/catalog.git');
    expect(instance.lastFrame()).not.toContain('下载方式');
  });

  it('shows an explicitly cleared Catalog subdirectory as the repository root', async () => {
    const loaded = loadResult();
    const longSubdir = `catalog/${'团队来源目录/'.repeat(18)}来源修改前唯一结尾`;
    const configured = loaded.configuredSources?.find((source) => source.id === 'team-tools');
    if (configured?.type !== 'git') throw new Error('expected Git source fixture');
    configured.subdir = longSubdir;
    const detail = loaded.sourceDetails?.find((source) => source.id === 'team-tools');
    if (detail) detail.subdir = longSubdir;
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    value.push({ name: 'sourceEdit', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    await input(instance, '\u001B[B', '\u001B[B', '\r', '\u0015', '\r');
    expect(instance.lastFrame()).toContain('仓库根目录');
    expect(instance.lastFrame()).not.toContain('Catalog 子目录\n     catalog');
    await focusAction(instance, '查看修改汇总');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('Catalog 子目录');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    expect(value.snapshot.router.current.route.name).toBe('review');
    const detailPages: string[] = [];
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const frame = instance.lastFrame() ?? '';
      detailPages.push(frame);
      expect(frame.split('\n').length).toBeLessThanOrEqual(18);
      if (pageIndex > 0 && frame === detailPages.at(-2)) break;
      await input(instance, '\u001B[6~');
    }
    expect(detailPages.join('').replace(/\s/gu, '')).toContain('来源修改前唯一结尾');
    expect(detailPages.join('\n')).toContain('仓库根目录');
    await input(instance, 'b');
    expect(value.snapshot.router.current.route.name).toBe('sourceEdit');
  });

  it.each([[60, 18], [80, 24]] as const)(
    'keeps a multi-field source summary and its complete final change reachable at %ix%i',
    async (columns, rows) => {
    const loaded = loadResult();
    const configured = loaded.configuredSources?.find((source) => source.id === 'team-tools');
    if (configured?.type !== 'git') throw new Error('expected Git source fixture');
    configured.subdir = 'before/来源最后修改前唯一值';
    const detail = loaded.sourceDetails?.find((source) => source.id === 'team-tools');
    if (detail) detail.subdir = configured.subdir;
    const executeIntent = vi.fn();
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), executeIntent });
    value.push({ name: 'sourceEdit', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    const trace: AcceptanceTraceStep[] = [];
    await nextTurn(3);

    const nextUrl = `https://example.test/${'nested/'.repeat(12)}catalog.git`;
    await input(instance, '\r', '\u0015', nextUrl, '\r');
    await input(instance, '\u001B[B', '\u001B[B', '\r', '\u0015', 'after/来源最后修改后唯一值', '\r');
    await focusAction(instance, '查看修改汇总');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('修改来源');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    trace.push(acceptanceTraceStep(instance, { columns, rows }, '来源汇总与变化计数', []));
    for (const label of [value.snapshot.activeReview!.primaryLabel, '改为保存并启用', '返回修改']) {
      await focusAction(instance, label);
      expect(instance.lastFrame()).toContain(`› ${label}`);
      expect(executeIntent).not.toHaveBeenCalled();
      trace.push(acceptanceTraceStep(instance, { columns, rows }, `聚焦 ${label}`, ['ArrowDown']));
    }
    expect(value.snapshot.router.current.route.name).toBe('review');
    const pages: string[] = [];
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const frame = instance.lastFrame() ?? '';
      pages.push(frame);
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
      if (pageIndex > 0 && frame === pages.at(-2)) break;
      await input(instance, '\u001B[C');
    }
    const completeText = pages.join('\n').replace(/\s/gu, '');
    expect(completeText).toContain('修改项·Catalog子目录');
    expect(completeText).toContain('来源最后修改前唯一值');
    expect(completeText).toContain('来源最后修改后唯一值');
    expect(executeIntent).not.toHaveBeenCalled();
    trace.push(acceptanceTraceStep(instance, { columns, rows }, '完整来源变化尾部', ['Enter', 'ArrowRight']));
    await writeAcceptanceTrace(`source-save/multi-field-${columns}x${rows}`, trace);
    },
  );

  it('cancels a fixed-ref field without changing its parent source draft', async () => {
    const loaded = loadResult();
    loaded.configuredSources![1] = {
      id: 'team-tools', type: 'git', primary: false,
      url: 'https://example.test/team.git',
      refPolicy: { type: 'cliChannel' }, autoCheck: true,
    };
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    value.push({ name: 'sourceEdit', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);

    await input(instance, '\u001B[B', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'sourceAdd', step: 'ref' });
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(3);

    expect(value.snapshot.router.current.route.name).toBe('sourceEdit');
    expect(value.hasSessionDraft).toBe(false);
  });

  it('renders safe source detail and technical data without raw path, credentials, or failure text', async () => {
    const secretPath = '/Users/private/acme/catalog';
    const secretUrl = 'https://token:secret@example.test/team.git';
    const loaded = loadResult();
    loaded.sourceDetails = loaded.sourceDetails!.map((detail) => detail.id === 'team-tools'
      ? { ...detail, locationSummary: 'https://example.test/team.git' }
      : detail.id === 'research' ? { ...detail, locationSummary: '已选择本地目录（catalog）' } : detail);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(5);
    expect(instance.lastFrame()).not.toContain('https://example.test/team.git');
    expect(instance.lastFrame()).not.toContain(secretPath);
    expect(instance.lastFrame()).not.toContain(secretUrl);
    await focusAction(instance, '来源设置');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('https://example.test/team.git');
    await escape(instance);
    await focusAction(instance, '更多操作');
    await input(instance, '\r');
    await focusAction(instance, '技术详情');
    await input(instance, '\r');
    expect(screens).toContain('S03');
    expect(instance.lastFrame()).toContain('catalogSourceReady');
    expect(instance.lastFrame()).toContain('requested ref');
    expect(instance.lastFrame()).not.toContain('sourceIdentity');
    expect(instance.lastFrame()).not.toContain('configDigest');
    expect(instance.lastFrame()).not.toContain('/Users/private');
    expect(instance.lastFrame()).not.toContain('token:secret');
  });

  it('pages every healthy source technical field from the rendered diagnostic at 60x18', async () => {
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loadResult()) });
    await value.load();
    value.push({ name: 'sourceTechnical', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    let frames = instance.lastFrame() ?? '';
    expect(frames).toContain('←→ 翻页');
    expect(frames).not.toContain('p 上一页');
    expect(frames).not.toContain('n 下一页');
    for (let page = 0; page < 7; page += 1) {
      await input(instance, '\u001B[C');
      frames += `\n${instance.lastFrame() ?? ''}`;
    }
    expect(frames).toContain('catalogSourceReady');
    expect(frames).toContain('catalog/stable');
    expect(frames).toContain('abc123');
  });

  it('shows structured candidate capability diagnostics while preserving the old Active', async () => {
    const missing = ['aw.catalog.future-one.v1', 'aw.catalog.future-two.v1'];
    const value = controller({
      probeCatalogFreshness: vi.fn(async (sourceId: string) => {
        if (sourceId === 'team-tools') throw new CatalogProviderCompatibilityError({
          sourceId,
          requiredCapabilities: missing,
          missingCapabilities: missing,
          availableCapabilities: ['aw.current.v1'],
        });
        return { sourceId, state: 'current' as const };
      }),
    });
    await value.load();
    await nextTurn(5);
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 28 }} />);
    await nextTurn(2);

    const detail = instance.lastFrame() ?? '';
    expect(detail).toContain('当前 AW 缺少 2 项待检查版本所需功能');
    expect(detail).toContain('当前目录版本 2.4.0 仍可浏览和使用');
    expect(detail).not.toContain('更新到候选版本');
    await focusAction(instance, '检查来源');
    expect(instance.lastFrame()).toContain('› 检查来源');

    value.push({ name: 'sourceTechnical', sourceId: 'team-tools' });
    await nextTurn(2);
    const technical = instance.lastFrame() ?? '';
    expect(technical).toContain(missing[0]);
    expect(technical).toContain(missing[1]);
    expect(technical).not.toContain('aw.current.v1');
    instance.unmount();
  });

  it('records manual source-check failures with a safe report link', async () => {
    const loaded = loadResult();
    loaded.sourceDetails = loaded.sourceDetails.map((detail) =>
      detail.id === 'team-tools' ? { ...detail, autoCheck: false } : detail);
    const probeCatalogFreshness = vi.fn(async () => {
      throw attachSafeOperationError(
        new Error('Authorization=private-token /Users/private/catalog'),
        { code: 'catalogProbeFailed', stage: 'probe-source', safeMessage: 'Catalog source check failed safely.' },
      );
    });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      probeCatalogFreshness,
    });
    await value.load();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    await focusAction(instance, '检查来源');
    await input(instance, '\r');
    await vi.waitFor(() => expect(value.getCatalogFreshness('team-tools')).toMatchObject({
      state: 'checkFailed', operationRecordId: expect.any(String),
    }));
    const recordId = value.getCatalogFreshness('team-tools')!.operationRecordId!;
    expect(value.getOperationDiagnostic(recordId)).toBeDefined();
    expect(JSON.stringify(value.getOperationDiagnostic(recordId))).not.toContain('private-token');
    await focusAction(instance, '更多操作');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('查看检查诊断与报告');
  });

  it('separates source identity change from capability recovery and unknown compatibility', async () => {
    const identityLoaded = loadResult();
    identityLoaded.catalogGenerations = identityLoaded.catalogGenerations?.map((generation) =>
      generation.sourceId === 'team-tools' ? {
        ...generation,
        state: 'unavailable' as const,
        errorCode: 'catalogLogicalIdentityChanged',
      } : generation);
    const identityValue = controller({
      loadStatus: vi.fn().mockResolvedValue(identityLoaded),
      probeCatalogFreshness: undefined,
    });
    await identityValue.load();
    identityValue.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const identityInstance = render(<ConsoleAppV4 controller={identityValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    const identityFrame = identityInstance.lastFrame() ?? '';
    expect(identityFrame).toContain('来源发布身份已变化');
    expect(identityFrame).toMatch(/旧 Active\s+是否仍可用需要单独验证/u);
    expect(identityFrame).not.toContain('升级 AW');
    expect(identityFrame).not.toContain('缺少 0 项');
    identityInstance.unmount();

    const unknownLoaded = loadResult();
    unknownLoaded.catalogGenerations = unknownLoaded.catalogGenerations?.map((generation) =>
      generation.sourceId === 'team-tools' ? {
        ...generation,
        state: 'incompatible' as const,
        compatibility: {
          state: 'unsupported' as const,
          requiredCapabilities: [],
          missingCapabilities: [],
        },
      } : generation);
    const unknownValue = controller({
      loadStatus: vi.fn().mockResolvedValue(unknownLoaded),
      probeCatalogFreshness: undefined,
    });
    await unknownValue.load();
    unknownValue.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const unknownInstance = render(<ConsoleAppV4 controller={unknownValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    const unknownFrame = unknownInstance.lastFrame() ?? '';
    expect(unknownFrame).toContain('所需功能无法确认');
    expect(unknownFrame).not.toContain('缺少 0 项');
    expect(unknownFrame).not.toContain('升级 AW');
  });

  it('shows no-Active capability diagnostics without offering an activation action', async () => {
    const missing = ['aw.catalog.future-one.v1', 'aw.catalog.future-two.v1'];
    const loaded = loadResult();
    loaded.payload.catalog.sources = loaded.payload.catalog.sources.map((source) => {
      if (source.id !== 'team-tools') return source;
      const { resolvedCommit: _resolvedCommit, catalogVersion: _catalogVersion,
        channel: _channel, freshness: _freshness, ...rest } = source;
      return { ...rest, error: 'unavailable', errorCode: 'catalogSourceUnavailable' };
    });
    loaded.catalogGenerations = loaded.catalogGenerations?.map((generation) =>
      generation.sourceId === 'team-tools' ? {
        sourceId: 'team-tools', sourceType: 'git' as const,
        state: 'activationRequired' as const,
        errorCode: 'catalogGenerationUnavailable',
      } : generation);
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      probeCatalogFreshness: vi.fn(async (sourceId: string) => {
        if (sourceId === 'team-tools') throw new CatalogProviderCompatibilityError({
          sourceId,
          requiredCapabilities: missing,
          missingCapabilities: missing,
          availableCapabilities: ['aw.current.v1'],
        });
        return { sourceId, state: 'current' as const };
      }),
    });
    await value.load();
    await nextTurn(5);
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 28 }} />);
    await nextTurn(2);

    const detail = instance.lastFrame() ?? '';
    expect(detail).toContain('当前 AW 缺少 2 项待检查版本所需功能');
    expect(detail).toContain('这个来源没有已验证可用的目录版本');
    expect(detail).toContain('来源设置');
    expect(detail).not.toContain('获取并启用');
    expect(detail).not.toContain('启用并设为主来源');
    expect(detail).not.toContain('当前 Active Catalog 保持不变');

    await focusAction(instance, '更多操作');
    expect(instance.lastFrame()).toContain('› 更多操作');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('检查来源');

    value.push({ name: 'sourceTechnical', sourceId: 'team-tools' });
    await nextTurn(2);
    const technical = instance.lastFrame() ?? '';
    expect(technical).toContain('awCapabilityUnsupported');
    expect(technical).toContain(missing[0]);
    expect(technical).toContain(missing[1]);
    expect(technical).not.toContain('aw.current.v1');
    instance.unmount();
  });

  it('never echoes Git credentials or query tokens while S06 is receiving input', async () => {
    const value = controller();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);
    await input(instance, '\u001B[B', '\u001B[B', '\r');
    await focusBottomAction(instance, '＋ 添加来源');
    await input(instance, '\r', '\r');
    await input(instance, 'safe-input', '\r');
    await input(instance, 'https://user:secret@example.test/catalog.git?token=private#fragment');

    expect(instance.lastFrame()).toContain('https://example.test/catalog.git');
    expect(instance.lastFrame()).not.toMatch(/user:secret|token=private|#fragment/u);
    expect(JSON.stringify(value.snapshot)).not.toMatch(/user:secret|token=private|#fragment/u);
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('Git URL 不符合来源规范');
    expect(instance.lastFrame()).not.toMatch(/user:secret|token=private|#fragment/u);
  });

  it('opens removal Review without consulting an incomplete reference inventory', async () => {
    const inspectSourceRemoval = vi.fn().mockResolvedValue({
      blocked: true,
      inventoryComplete: false,
      dependencies: [{
        category: 'installation',
        pluginId: 'team-tools/review-gate',
        sourceId: 'team-tools',
        platform: 'codex',
        scope: 'project',
      }],
    });
    const executeIntent = vi.fn().mockResolvedValue({ ok: true });
    const value = controller({
      inspectSourceRemoval,
      captureEvidence: vi.fn().mockResolvedValue({
        ...evidence,
        sourceWrite: {
          configDigest: 'sha256:before',
          proposedConfigDigest: 'sha256:after',
          inventoryDigest: 'sha256:inventory',
          referenceCount: 4,
          inventoryComplete: false,
          impact: {
            impactSchemaVersion: 3,
            primaryChange: null,
            sourceId: 'team-tools',
            inventoryComplete: false,
            references: [
              { category: 'installation', sourceId: 'team-tools', pluginId: 'team-tools/review-gate' },
              { category: 'config', sourceId: 'team-tools', pluginId: 'team-tools/review-gate' },
              { category: 'lifecycle', sourceId: 'team-tools', pluginId: 'team-tools/review-gate' },
              { category: 'marketplace', sourceId: 'team-tools', marketplaceName: 'aw-team' },
            ],
            affectedReferences: [
              { category: 'installation', sourceId: 'team-tools', pluginId: 'team-tools/review-gate' },
              { category: 'config', sourceId: 'team-tools', pluginId: 'team-tools/review-gate' },
              { category: 'lifecycle', sourceId: 'team-tools', pluginId: 'team-tools/review-gate' },
              { category: 'marketplace', sourceId: 'team-tools', marketplaceName: 'aw-team' },
            ],
            changes: {
              added: [], removed: [], changed: [], newlyIncompatible: [],
              dependencyChanged: [], platformSupportChanged: [],
            },
            errors: [{ code: 'stateInventoryFailed', kind: 'nativeStateRead' }],
          },
        },
      }),
      executeIntent,
    });
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(5);
    await focusAction(instance, '移除来源');
    await input(instance, '\r');
    await nextTurn(3);
    expect(screens).toContain('S18');
    expect(value.snapshot.activeReview?.sourceAction).toBe('remove');
    expect(inspectSourceRemoval).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('安装引用受影响');
    expect(instance.lastFrame()).toContain('生命周期意图引用受影响');
    expect(instance.lastFrame()).toContain('来源影响未知');
    await input(instance, '\r');
    expect(executeIntent).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('返回检查');
  });

  it('reaches the last blocked source reference at 60x18', async () => {
    const dependencies = Array.from({ length: 20 }, (_, index) => ({
      category: 'installation' as const,
      pluginId: `ref-${index}`,
      sourceId: 'team-tools',
      platform: 'codex' as const,
      scope: 'project' as const,
    }));
    const value = controller({
      inspectSourceRemoval: vi.fn().mockResolvedValue({
        blocked: true, inventoryComplete: true, installationCount: 20,
        dependencies,
      }),
    });
    await value.load();
    value.push({ name: 'sourceRemoveBlocked', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('←→ 翻页');
    for (let page = 0; page < 25; page += 1) await input(instance, '\u001B[C');

    expect(instance.lastFrame()).toContain('ref-19');
    expect(instance.lastFrame()).toContain('20 / 20');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
  });

  it.each([
    ['repairRequired', '来源目录损坏，当前无法使用'],
    ['stateInvalid', '来源状态需要恢复'],
    ['configMismatch', '来源设置与当前目录不一致'],
    ['unavailable', '来源尚未启用'],
    ['incompatible', '当前 AW 无法使用这个目录版本'],
  ] as const)('projects a missing source version state %s as %s', async (state, label) => {
    const loaded = loadResult();
    loaded.catalogGenerations = loaded.catalogGenerations?.map((generation) =>
      generation.sourceId === 'team-tools' ? { ...generation, active: undefined, state } : generation);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain(label);
    expect(instance.lastFrame()).not.toContain(state);
  });

  it('[source-detail/damaged-default] keeps damaged Active unavailable when its freshness check also fails', async () => {
    const loaded = loadResult();
    loaded.catalogGenerations = loaded.catalogGenerations?.map((generation) =>
      generation.sourceId === 'team-tools'
        ? { ...generation, state: 'repairRequired' as const }
        : generation);
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      probeCatalogFreshness: vi.fn(async () => { throw new Error('remote check failed'); }),
    });
    await value.load();
    await value.recheckCatalogSource('team-tools');
    value.push({ name: 'sourceList' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    expect(instance.lastFrame()).toContain('official');
    expect(instance.lastFrame()).toContain('检查失败 · 当前版本可用');
    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('team-tools');
    expect(instance.lastFrame()).toContain('检查失败 · 当前版本不可用');

    await input(instance, '\r');
    const detail = instance.lastFrame() ?? '';
    expect(detail).toContain('当前目录版本缺失或损坏。可在这里精确修复。');
    expect(detail).toContain('来源目录损坏，当前无法使用');
    expect(detail).toContain('本次检查 检查失败');
    expect(detail).toContain('检查失败');
    expect(detail).toContain('恢复来源');
    expect(detail).not.toContain('仍可浏览和使用');
    expect(detail).not.toContain('当前版本仍可用');
    expect(detail).not.toContain('当前版本继续可用');
  });

  it('opens the damaged Active replacement Review and requires explicit impact confirmation', async () => {
    const loaded = loadResult();
    loaded.catalogGenerations = loaded.catalogGenerations?.map((generation) =>
      generation.sourceId === 'team-tools'
        ? { ...generation, state: 'repairRequired' as const }
        : generation);
    const executeIntent = vi.fn().mockResolvedValue({ status: 'succeeded' });
    const captureEvidence = vi.fn(async (intent: OperationIntent) => {
      const prepared = evidenceForIntent(intent);
      if (intent.kind !== 'catalogGeneration' || !prepared.catalogGeneration) return prepared;
      return {
        ...prepared,
        catalogGeneration: {
          ...prepared.catalogGeneration,
          previousActive: {
            sourceConfigFingerprint: 'sha256:old-config',
            sourceIdentity: 'identity:team-tools',
            logicalIdentity: 'workspace:team-tools',
            requestedRef: 'catalog/stable',
            resolvedCommit: 'old123',
            manifestDigest: 'sha256:old-manifest',
            snapshotDigest: 'sha256:old-snapshot',
            activatedAt: 500,
          },
          impact: {
            impactSchemaVersion: 3,
            primaryChange: null,
            sourceId: 'team-tools',
            inventoryComplete: false,
            references: [{ category: 'lifecycle' as const, sourceId: 'team-tools', pluginId: 'team-tools/review-gate' }],
            affectedReferences: [],
            changes: {
              added: [], removed: [], changed: [], newlyIncompatible: [],
              dependencyChanged: [], platformSupportChanged: [],
            },
            errors: [{ code: 'catalogManifestUnavailable' as const, kind: 'currentManifestRead' }],
          },
        },
      };
    });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
      executeIntent,
    });
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);
    expect(instance.lastFrame()).toContain('恢复来源');

    await focusAction(instance, '更多操作');
    await input(instance, '\r');
    await focusAction(instance, '使用待检查版本替换损坏版本');
    await input(instance, '\r');
    await nextTurn(3);
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'catalogGeneration', action: 'replaceDamaged', sourceId: 'team-tools',
    }), expect.anything());
    expect(instance.lastFrame()).toContain('替换损坏的当前启用版本');
    expect(instance.lastFrame()).toContain('待检查版本的影响未知');
    await input(instance, '\r');
    expect(executeIntent).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('返回检查');
    await input(instance, '\r');
    expect(executeIntent).not.toHaveBeenCalled();
    await input(instance, '\r', '\u001B[B', '\r');
    expect(executeIntent).toHaveBeenCalledOnce();
  });

  it.each([[60, 18], [80, 24]] as const)(
    'opens every safe catalog update reference from the ordinary Review at %ix%i',
    async (columns, rows) => {
    const sharedPrefix = `team-tools/${'shared-reference-prefix-'.repeat(5)}`;
    const tails = ['installation-tail', 'config-tail', 'lifecycle-tail', 'marketplace-tail'];
    const identifiers = tails.map((tail) => `${sharedPrefix}${tail}`);
    const references = [
      { category: 'installation' as const, sourceId: 'team-tools', pluginId: identifiers[0], platform: 'codex' as const, scope: 'project' as const },
      { category: 'config' as const, sourceId: 'team-tools', pluginId: identifiers[1] },
      { category: 'lifecycle' as const, sourceId: 'team-tools', pluginId: identifiers[2] },
      { category: 'marketplace' as const, sourceId: 'team-tools', marketplaceName: identifiers[3] },
    ];
    const value = controller({
      captureEvidence: vi.fn(async (intent: OperationIntent) => {
        const prepared = evidenceForIntent(intent);
        if (intent.kind !== 'catalogGeneration' || !prepared.catalogGeneration) return prepared;
        return {
          ...prepared,
          catalogGeneration: {
            ...prepared.catalogGeneration,
            impact: {
              impactSchemaVersion: 3 as const,
              primaryChange: null,
              sourceId: 'team-tools',
              inventoryComplete: true,
              references,
              affectedReferences: [references[0]!],
              changes: {
                added: [], removed: [], changed: [], newlyIncompatible: [],
                dependencyChanged: [], platformSupportChanged: [],
              },
              errors: [],
            },
          },
        };
      }),
    });
    await value.load();
    await value.buildOperationReview({ kind: 'catalogGeneration', action: 'update', sourceId: 'team-tools' });
    for (const identifier of identifiers) {
      expect(value.snapshot.activeReview?.technicalDetails).toEqual(
        expect.arrayContaining([expect.stringContaining(identifier)]),
      );
    }
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(3);

    expect(instance.lastFrame()).toContain('现有引用受待检查版本影响 · 1 项');
    await focusAction(instance, '查看完整引用影响');
    await input(instance, '\r');
    let traversal = instance.lastFrame() ?? '';
    for (let page = 0; page < 40; page += 1) {
      await input(instance, '\u001B[D');
      traversal += `\n${instance.lastFrame() ?? ''}`;
    }
    for (let page = 0; page < 40 && !tails.every((tail) => traversal.includes(tail)); page += 1) {
      await input(instance, '\u001B[C');
      traversal += `\n${instance.lastFrame() ?? ''}`;
    }
    expect(traversal).toContain('引用影响：受影响 · 安装');
    for (const marker of ['安装', '设置', '生命周期', 'Marketplace']) expect(traversal).toContain(marker);
    for (const tail of tails) expect(traversal).toContain(tail);
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
  });

  it('reaches edit, primary, and safe removal Review pages through mounted keyboard actions', async () => {
    const edit = controller();
    edit.push({ name: 'sourceEdit', sourceId: 'team-tools' });
    const editScreens = new Set<ConsoleV4ScreenId>();
    const editView = render(<ConsoleAppV4 controller={edit} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => editScreens.add(screen)} />);
    await nextTurn(5);
    await input(editView, '\r');
    await nextTurn(4);
    await input(editView, ...Array.from({ length: 'https://example.test/team.git'.length }, () => '\u007F'), 'https://example.test/team-v2.git');
    expect(editView.lastFrame()).toContain('team-v2.git');
    await input(editView, '\r');
    await input(editView, ...Array.from({ length: 4 }, () => '\u001B[B'), '\r');
    await chooseSourceSave(editView, edit, 'enable');
    expect(editScreens).toContain('S14');
    expect(editScreens).toContain('S15');
    cleanup();

    const primary = controller();
    primary.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const primaryScreens = new Set<ConsoleV4ScreenId>();
    const primaryView = render(<ConsoleAppV4 controller={primary} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => primaryScreens.add(screen)} />);
    await nextTurn(5);
    await focusAction(primaryView, '更多操作');
    await input(primaryView, '\r');
    await focusAction(primaryView, '设为主来源');
    await input(primaryView, '\r');
    await nextTurn(3);
    expect(primaryScreens).toContain('S16');
    cleanup();

    const removal = controller();
    removal.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const removalScreens = new Set<ConsoleV4ScreenId>();
    const removalView = render(<ConsoleAppV4 controller={removal} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => removalScreens.add(screen)} />);
    await nextTurn(5);
    await focusAction(removalView, '移除来源');
    await input(removalView, '\r');
    await nextTurn(3);
    expect(removalScreens).toContain('S18');
  });

  it('keeps a source draft and reports uncertainty after a sanitized command failure', async () => {
    const rawFailure = 'remote failed https://token:secret@example.test/private.git /Users/private/catalog';
    const value = controller({ executeIntent: vi.fn().mockRejectedValue(new Error(`catalogSourceResolutionFailed: ${rawFailure}`)) });
    await value.load();
    await value.buildOperationReview({
      kind: 'sourceMutation',
      action: 'add',
      sourceId: 'safe-id',
      source: { id: 'safe-id', type: 'git', primary: false, url: 'https://example.test/catalog.git', refPolicy: { type: 'cliChannel' } },
      changes: [{ title: '添加来源 safe-id', after: 'Git 仓库' }],
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(screens).toContain('S13');
    expect(instance.lastFrame()).toContain('写入可能已完成，当前无法确认');
    expect(instance.lastFrame()).not.toContain('来源列表没有被修改');
    expect(instance.lastFrame()).not.toContain('token:secret');
    expect(instance.lastFrame()).not.toContain('/Users/private');
  });

  it('does not claim a source list was unchanged after a source write reload fails', async () => {
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:candidate' },
      sourceWrite: {
        configDigest: 'sha256:before', proposedConfigDigest: 'sha256:candidate',
        inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true,
      },
    };
    const value = controller({
      loadStatus: vi.fn()
        .mockResolvedValueOnce(loadResult())
        .mockRejectedValueOnce(new Error('/private/reload failed')),
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
    });
    await value.load();
    value.push({ name: 'sourceList' });
    const review = await value.buildOperationReview({
      kind: 'sourceMutation', action: 'setPrimary', sourceId: 'team-tools',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('写入可能已完成，当前无法确认');
    expect(instance.lastFrame()).not.toContain('来源列表没有被修改');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceList' });
  });
});
