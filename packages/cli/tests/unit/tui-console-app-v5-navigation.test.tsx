import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import {
  CONSOLE_V4_SCREEN_IDS,
  ConsoleAppV4,
  type ConsoleV4ScreenId,
} from '../../src/tui/console-app-v4.js';
import {
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import { OperationHistoryStore } from '../../src/tui/operation-history.js';
import { copyToClipboard } from '../../src/tui/clipboard.js';
import { SessionConsoleApp } from '../../src/tui/session-console-app.js';
import { SessionHost } from '../../src/tui/session-host.js';
import { attachSafeOperationError } from '../../src/utils/safe-operation-diagnostic.js';

vi.mock('../../src/tui/clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import {
  configPage,
  controller,
  deferred,
  loadResult,
} from '../helpers/tui-console-app-fixture.js';

import {
  escape,
  focusAction,
  focusBottomAction,
  input,
  nextTurn,
  writeAcceptanceTrace,
} from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

describe('ConsoleAppV4', () => {
  it('keeps the complete reachable screen map free of duplicate identities', () => {
    expect(CONSOLE_V4_SCREEN_IDS).toHaveLength(129);
    expect(new Set(CONSOLE_V4_SCREEN_IDS)).toHaveProperty('size', 129);
    expect(CONSOLE_V4_SCREEN_IDS).toEqual([
      'G01', 'G02', 'G03', 'G04', 'G05', 'G06',
      'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10',
      'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P21', 'P22',
      'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10',
      'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17', 'C18', 'C19', 'C20',
      'C21', 'C22', 'C23',
      'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09',
      'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17', 'S18',
      'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09',
      'I10', 'I11', 'I12', 'I13',
      'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09',
      'D10', 'D11', 'D12', 'D13', 'D14', 'D15', 'D16', 'D17',
      'D18', 'D19', 'D20',
      'U01', 'U02', 'U03', 'U04', 'U05', 'U06', 'U07', 'U08', 'U09', 'U10', 'U11', 'U22',
      'K02',
      'B01', 'B02', 'B06', 'B07',
      'T01', 'T02', 'T03', 'T04', 'T05',
      'L01', 'L02', 'L03', 'L04', 'L05', 'L06',
    ]);
  });

  it('mounts the loading skeleton and keeps ordinary exit separate from G04 discard', async () => {
    const screens: ConsoleV4ScreenId[] = [];
    const exit = vi.fn();
    const value = controller();
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onExit={exit}
      onScreenChange={(screen) => screens.push(screen)}
    />);
    expect(instance.lastFrame()).toContain('正在检查插件状态');
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('项目插件');

    await input(instance, '?');
    expect(instance.lastFrame()).toContain('当前页快捷键');
    await input(instance, '?', 'q');
    expect(instance.lastFrame()).toContain('退出控制台？');
    await input(instance, '\u001B[B');
    await input(instance, '\r');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
    expect(screens).toEqual(expect.arrayContaining(['G01', 'G02', 'G03']));
    expect(screens).not.toContain('G04');
  });

  it.each([
    ['q', undefined],
    ['h', 'home'],
    ['H', 'reload'],
  ] as const)('keeps %s available from help through the common navigation path', async (key, navigation) => {
    const value = controller();
    const onSessionNavigation = vi.fn(async () => 'completed' as const);
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 60, rows: 18 }}
      onSessionNavigation={onSessionNavigation}
    />);
    await nextTurn(2);
    await input(instance, '?', key);
    if (navigation) expect(onSessionNavigation).toHaveBeenCalledWith(navigation, expect.any(Object));
    else expect(instance.lastFrame()).toContain('退出控制台？');
  });

  it.each([[60, 18], [80, 24]] as const)(
    'keeps storage rules user-facing and preserves exact cleanup evidence at %ix%i',
    async (columns, rows) => {
      const value = controller();
      await value.load();
      value.push({ name: 'catalogStoreRules' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);

      const ordinary = instance.lastFrame() ?? '';
      expect(ordinary).toContain('始终保留');
      expect(ordinary).toContain('满足时间和完整验证后可回收');
      expect(ordinary).toContain('当前使用的目录不会删除');
      expect(ordinary).toContain('旧版本满足保留期限后才清理');
      expect(ordinary).toContain('隔离内容至少保留 24 小时');
      expect(ordinary).toContain('对应正式版本完整可用后才清理');
      expect(ordinary).toContain('技术详情');
      expect(ordinary).not.toContain('返回存储概览');
      expect(ordinary).not.toContain('AW_HOME 写锁');
      expect(ordinary).not.toContain('delete claim');
      await input(instance, 'd');
      const technical = instance.lastFrame() ?? '';
      expect(technical).toContain('AW_HOME 写锁内重新检查');
      expect(technical).toContain('非 Active 项保留 30 天');
      expect(technical).toContain('staging、replacement、delete claim');
      expect(technical).toContain('foreign、符号链接、unsafe、损坏或未知项目');
      expect(technical.split('\n').length).toBeLessThanOrEqual(rows);
      await input(instance, 'd');
      const returned = instance.lastFrame() ?? '';
      expect(returned).toContain('满足时间和完整验证后可回收');
      expect(returned).toContain('对应正式版本完整可用后才清理');
    },
  );

  it.each([
    [80, 24],
    [60, 18],
  ] as const)('keeps every G03 shortcut meaning and the single close focus visible at %ix%i', async (columns, rows) => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    await value.load();
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns, rows }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await nextTurn(2);
    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 项目插件');

    await input(instance, '?');
    const readHelp = async (): Promise<string> => {
      let result = instance.lastFrame() ?? '';
      const pages = Number(result.match(/\d+ \/ (\d+)/u)?.[1] ?? 1);
      for (let page = 1; page < pages; page += 1) {
        await input(instance, '\u001B[C');
        const frame = instance.lastFrame() ?? '';
        expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
        result += `\n${frame}`;
      }
      return result;
    };
    const homeHelp = await readHelp();
    for (const meaning of [
      '↑↓ 移动', 'Enter 选择', 'q / Ctrl-C 退出控制台',
      'o 查看操作记录', 'Esc / ? 关闭帮助',
    ]) {
      expect(homeHelp).toContain(meaning);
    }
    for (const direction of ['\u001B[A', '\u001B[B', '\u001B[D', '\u001B[C']) {
      await input(instance, direction);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('› 关闭');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    }
    expect(screens).toContain('G03');

    await input(instance, '\r');
    expect(instance.lastFrame()).not.toContain('当前页快捷键');
    expect(instance.lastFrame()).toContain('› 项目插件');
    await input(instance, '?');
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTurn(2);
    expect(instance.lastFrame()).not.toContain('当前页快捷键');
    expect(instance.lastFrame()).toContain('› 项目插件');
    await input(instance, '?', '?');
    expect(instance.lastFrame()).not.toContain('当前页快捷键');
    expect(instance.lastFrame()).toContain('› 项目插件');

    value.push({ name: 'pluginList', mode: 'browse' });
    await nextTurn(2);
    await input(instance, '?');
    const listHelp = await readHelp();
    expect(listHelp).toContain('←→ 来源');
    expect(listHelp).toContain('/ 搜索');
    await input(instance, '?');

    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('? 帮助');
    await input(instance, '?');
    expect(instance.lastFrame()).toContain('当前页快捷键');
    expect(await readHelp()).toContain('Esc 返回');
    await input(instance, '?');

    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    await nextTurn(2);
    await input(instance, '?');
    const graphHelp = await readHelp();
    expect(graphHelp).toContain('Enter 插件详情');
    expect(graphHelp).not.toContain('d 技术详情');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    await input(instance, '?');

    value.replace({ name: 'sourceList' });
    await nextTurn(2);
    await input(instance, '?');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    await input(instance, '?');

    value.replace({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    await nextTurn(3);
    await input(instance, '?');
    const configHelp = await readHelp();
    expect(configHelp).not.toContain('s 查看汇总');
    expect(configHelp).toContain('u 恢复继承');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    await input(instance, '?');
  });

  it('keeps unfinished loading work active or pending without claiming completion', async () => {
    const pendingLoad = deferred<TuiStatusLoadResult>();
    const value = controller({ loadStatus: vi.fn(() => pendingLoad.promise) });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('● 读取插件来源');
    expect(instance.lastFrame()).toContain('○ 检查当前项目');
    expect(instance.lastFrame()).not.toContain('✓ 读取插件来源');
    pendingLoad.resolve(loadResult());
    await nextTurn(3);
  });

  it('shows unavailable source counts on the mounted home page', async () => {
    for (const size of [{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }]) {
      const instance = render(<ConsoleAppV4 controller={controller()} size={size} />);
      await nextTurn(3);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('1 不可用');
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
      instance.unmount();
      instance.cleanup();
    }
  });

  it('does not treat target platform selection as an unsaved write', async () => {
    const screens: ConsoleV4ScreenId[] = [];
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => screens.push(screen)}
      onExit={exit}
    />);
    await nextTurn(3);

    await input(instance, '\r', 'q');
    expect(instance.lastFrame()).toContain('退出控制台？');
    expect(screens).not.toContain('G04');
    await input(instance, '\u001B[B', '\r');

    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
  });

  it('keeps the same-scope target selection after Back and confirms Ctrl-C from help', async () => {
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(3);

    await focusAction(instance, '安装');
    await input(instance, '\r', '\r', 'a', '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installPlacement', pluginId: 'official/agent-lab' });
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
    expect(instance.lastFrame()).toContain('[x] Codex');
    expect(exit).not.toHaveBeenCalled();

    await input(instance, '?', '\u0003');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    expect(exit).not.toHaveBeenCalled();
    await input(instance, '\u001B[B', '\r');
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
  });

  it('keeps the ordinary exit overlay explicit after Ctrl-C', async () => {
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(3);
    await input(instance, '\r', 'q', '\u0003');
    expect(instance.lastFrame()).toContain('退出控制台？');
    expect(exit).not.toHaveBeenCalled();
    await input(instance, '\u001B[B', '\r');
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
  });

  it('does not dispose an externally owned controller and exits initial load failure nonzero', async () => {
    const exit = vi.fn();
    const value = controller({ loadStatus: vi.fn().mockRejectedValue(new Error('statusUnavailable: private')) });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('无法读取插件状态');
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('安全诊断');
    expect(instance.lastFrame()).toContain('d 返回摘要');
    expect(instance.lastFrame()).not.toContain('d 技术详情');
    await input(instance, '\u0003');
    expect(instance.lastFrame()).toContain('退出控制台？');
    expect(exit).not.toHaveBeenCalled();
    await input(instance, '\u001B[B', '\r');
    expect(exit).toHaveBeenCalledWith({ code: 1, reason: 'initialError' });
    instance.unmount();
    expect(value.snapshot.phase).toBe('error');
  });

  it('records a safe rejected action through the real menu action and ignores sync and async aborts', async () => {
    const secret = 'Authorization=private-token';
    const value = controller();
    await value.load();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const recheck = vi.spyOn(value, 'recheckCatalogSource').mockRejectedValueOnce(
      attachSafeOperationError(new Error(`raw ${secret}`), {
        code: 'catalogGitAuthorizationFailed',
        stage: 'catalog.fetch',
        safeMessage: 'Catalog authorization is required.',
        exitCode: 17,
        cause: { code: 'EACCES', safeMessage: 'The service denied access.' },
      }),
    );
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await focusAction(instance, '检查来源');
    await input(instance, '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('operationDiagnostic');
    const detail = value.getOperationDiagnostic(
      (value.snapshot.router.current.route as { recordId: string }).recordId,
    );
    expect(detail?.diagnostics).toEqual([expect.objectContaining({
      code: 'catalogGitAuthorizationFailed', stage: 'catalog.fetch', exitCode: 17,
      causes: [{ code: 'EACCES', safeMessage: 'The service denied access.' }],
    })]);
    expect(JSON.stringify({ snapshot: value.snapshot, detail })).not.toContain(secret);
    expect(JSON.stringify({ snapshot: value.snapshot, detail })).not.toContain('raw');

    const recordCount = value.listOperationHistory().length;
    value.replace({ name: 'sourceDetail', sourceId: 'team-tools' });
    recheck.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    await nextTurn(2);
    await focusAction(instance, '检查来源');
    await input(instance, '\r');
    await nextTurn(2);
    expect(value.listOperationHistory()).toHaveLength(recordCount);
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'team-tools' });

    recheck.mockImplementationOnce(() => { throw new DOMException('cancelled', 'AbortError'); });
    await focusAction(instance, '检查来源');
    await input(instance, '\r');
    await nextTurn(2);
    expect(value.listOperationHistory()).toHaveLength(recordCount);
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'team-tools' });
    instance.unmount();
  });

  it('handles Ctrl-C before search input and confirms without changing the query', async () => {
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(3);
    await input(instance, '/', '\u0003');
    expect(instance.lastFrame()).toContain('退出控制台？');
    expect(exit).not.toHaveBeenCalled();
    await input(instance, '\r');
    expect(instance.lastFrame()).toMatch(/搜索 ▌输入搜索内容 +\[\/\]/u);
    await input(instance, '\u0003');
    await input(instance, '\u001B[B', '\r');
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
  });

  it.each([{ columns: 60, rows: 18 }, { columns: 80, rows: 24 }])(
    'keeps busy help controls truthful and isolated at $columns x $rows', async (size) => {
      const pending = deferred<unknown>();
      const executeIntent = vi.fn(() => pending.promise);
      const value = controller({ executeIntent });
      await value.load();
      const review = await value.buildOperationReview({
        kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
      });
      const running = value.executeOperation(review.reviewToken);
      const navigate = vi.fn().mockResolvedValue('completed');
      const instance = render(<ConsoleAppV4 controller={value} size={size} onSessionNavigation={navigate} />);
      try {
        await nextTurn(2);
        await input(instance, '?');
        const first = instance.lastFrame() ?? '';
        expect(first).toContain('当前页快捷键');
        expect(first).not.toContain('o 查看操作记录');
        expect(first.split('\n').length).toBeLessThanOrEqual(size.rows);
        await input(instance, '\u001B[B');
        expect(instance.lastFrame()).toContain('› 操作成功后返回首页');
        await input(instance, '\u001B[C', '\u001B[D');
        expect(instance.lastFrame()).toContain('› 操作成功后返回首页');
        expect(value.snapshot.router.current.route.name).toBe('progress');
        expect(navigate).not.toHaveBeenCalled();
        await input(instance, '\u001B');
        await vi.waitFor(() => expect(instance.lastFrame()).not.toContain('当前页快捷键'));
        expect(value.snapshot.router.current.route.name).toBe('progress');
        await input(instance, '?', '\u001B[B', '\r');
        expect(navigate).toHaveBeenCalledWith('home', expect.any(Object));
        expect(value.snapshot.router.current.route.name).toBe('progress');
        expect(executeIntent).toHaveBeenCalledTimes(1);
      } finally {
        pending.resolve({ overallState: 'succeeded', targetResults: [] });
        await running;
        instance.unmount();
      }
    },
  );

  it('exits once after a busy stale operation returns to Review', async () => {
    const pending = deferred<unknown>();
    const exit = vi.fn();
    const value = controller({ executeIntent: vi.fn(() => pending.promise) });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    void value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(2);
    expect(value.snapshot.router.current.route.name).toBe('progress');

    await input(instance, '\u0003');
    pending.reject(new Error('operationReviewStale: changed'));
    await nextTurn(4);

    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'stale' });
  });

  it.each([
    ['Ctrl-C', '\u0003'],
    ['q', 'q'],
  ])('defers %s while a busy screen is too small and exits once after completion', async (_label, exitInput) => {
    const pending = deferred<unknown>();
    const exit = vi.fn();
    const value = controller({ executeIntent: vi.fn(() => pending.promise) });
    const dispose = vi.spyOn(value, 'dispose');
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    void value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} ownsController />);
    await nextTurn(2);
    expect(value.snapshot.router.current.route.name).toBe('progress');

    instance.rerender(<ConsoleAppV4 controller={value} size={{ columns: 52, rows: 14 }} onExit={exit} ownsController />);
    await input(instance, exitInput, '\r');
    expect(instance.lastFrame()).toContain('终端空间不足');
    expect(exit).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();

    pending.resolve({
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    await nextTurn(4);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'completed' });
  });

  it('renders only the minimum-size hint and ignores business input below 60x18', async () => {
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 59, rows: 18 }} onExit={exit} />);
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('请将终端调整到至少 60 列 × 18 行');
    expect(instance.lastFrame()).not.toContain('添加插件');
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('pluginList');
    await input(instance, 'q');
    expect(instance.lastFrame()).toContain('退出控制台？');
    expect(exit).not.toHaveBeenCalled();
    await input(instance, '\u001B[B', '\r');
    expect(exit).toHaveBeenCalledOnce();
  });

  it.each([[60, 18], [80, 24]] as const)(
    'keeps report save feedback, focused actions, and return visible at %ix%i',
    async (columns, rows) => {
    const value = controller();
    const recordId = value.recordUiFailure(undefined, {
      code: 'reportFixtureFailure', stage: 'report-fixture',
    });
    value.push({ name: 'operationDiagnostic', recordId });
    value.push({ name: 'operationReportPreview', recordId });
    const saveReport = vi.spyOn(value, 'saveOperationReport')
      .mockRejectedValueOnce(new Error('private report failure'))
      .mockResolvedValueOnce({ path: '/private/tmp/report.md' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(3);

    await focusAction(instance, '保存到临时目录');
    await input(instance, '\r');
    const failed = instance.lastFrame() ?? '';
    expect(failed).toContain('报告未保存');
    expect(failed).toContain('› 保存到临时目录');
    expect(failed).toMatch(/↑↓(?: 移动 · Enter 选择|\/Enter 菜单)/u);
    expect(failed).not.toContain('private report failure');
    expect(failed.split('\n').length).toBeLessThanOrEqual(rows);

    await input(instance, '\r');
    const saved = instance.lastFrame() ?? '';
    expect(saved).toContain('报告已保存到临时目录');
    expect(saved).toContain('› 保存到临时目录');
    expect(saved).toMatch(/↑↓(?: 移动 · Enter 选择|\/Enter 菜单)/u);
    expect(saved).not.toContain('/private/tmp/report.md');
    expect(saved.split('\n').length).toBeLessThanOrEqual(rows);
    await writeAcceptanceTrace(`reader/report-save-feedback-${columns}x${rows}`, [
      { label: '保存失败', size: { columns, rows }, inputs: ['Enter'], frame: failed },
      { label: '保存成功', size: { columns, rows }, inputs: ['Enter'], frame: saved },
    ]);

    for (const label of ['选择本地保存位置', '保存到临时目录']) {
      await focusAction(instance, label);
      expect(instance.lastFrame()).toContain(`› ${label}`);
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    }
    await escape(instance);
    expect(value.snapshot.router.current.route).toEqual({ name: 'operationDiagnostic', recordId });
    expect(saveReport).toHaveBeenCalledTimes(2);
    instance.unmount();
    },
  );

  it('shows an unavailable page when an open diagnostic record was evicted', async () => {
    const value = controller();
    const removed = value.recordUiFailure(undefined, { code: 'oldFailure', stage: 'old-stage' });
    for (let index = 0; index < 20; index += 1) {
      value.recordUiFailure(undefined, { code: `newFailure${index}`, stage: 'new-stage' });
    }
    value.push({ name: 'operationDiagnostic', recordId: removed });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    expect(value.snapshot.router.current.route).toEqual({ name: 'operationDiagnostic', recordId: removed });
    expect(instance.lastFrame()).toContain('操作记录已不可用');
    expect(instance.lastFrame()).toContain('记录已不可用');
    instance.unmount();
  });

  it('resets home focus and list context after global home navigation', async () => {
    const value = controller();
    await value.load();
    const onSessionNavigation = vi.fn(async (navigation: 'home' | 'reload') => {
      if (navigation === 'home') value.goHome();
      return 'completed' as const;
    });
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onSessionNavigation={onSessionNavigation}
    />);
    await nextTurn(3);

    await input(instance, '\u001B[B', '\u001B[B', 'h');
    expect(value.snapshot.router).toMatchObject({
      depth: 1,
      current: { route: { name: 'home' }, context: {} },
    });
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse' });

    await input(instance, 'h', '\u001B[B', '\u001B[B', '?', '\u001B[B', '\r', '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse' });
    expect(onSessionNavigation.mock.calls.filter(([navigation]) => navigation === 'home')).toHaveLength(3);
    instance.unmount();
  });

  it('resets an unavailable flow to home after confirming a real source draft', async () => {
    const value = controller();
    await value.load();
    const host = new SessionHost({
      createSession: () => ({ controller: value, progressFeed: createRebuildProgressFeed() }),
    });
    const instance = render(<SessionConsoleApp host={host} />);
    await nextTurn(3);
    await focusAction(instance, '插件来源');
    await input(instance, '\r');
    await focusBottomAction(instance, '＋ 添加来源');
    await input(instance, '\r', '\r');
    await input(instance, 'unfinished-source');
    expect(value.hasSessionDraft).toBe(true);

    value.push({ name: 'result', operationId: 'unavailable-operation' });
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('这个操作已结束或变化');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    expect(value.hasSessionDraft).toBe(true);

    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router).toMatchObject({
      depth: 1,
      current: { route: { name: 'home' }, context: {} },
    });
    await nextTurn(3);
    expect(value.hasSessionDraft).toBe(false);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse' });
    host.dispose();
  });

  it('cancels a pending Host navigation when Enter chooses continue editing', async () => {
    const value = controller();
    const draft = { kind: 'configDraft' as const, owner: 'plugin\0user', flowId: 'flow-1', revision: 1 };
    const cancelPending = vi.fn(() => true);
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      pendingSessionNavigation="home"
      pendingSessionNavigationDrafts={[draft]}
      onCancelPendingSessionNavigation={cancelPending}
      onSessionNavigation={vi.fn().mockResolvedValue('draftBlocked')}
    />);
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('放弃未保存修改？');

    await input(instance, '\r');
    expect(cancelPending).toHaveBeenCalledOnce();
    expect(instance.lastFrame()).not.toContain('放弃未保存修改？');
    instance.unmount();
  });

  it('keeps a source draft through read-only history and guards the real source-flow exit', async () => {
    const value = controller();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\u001B[B', '\u001B[B', '\r');
    await focusBottomAction(instance, '＋ 添加来源');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'sourceAdd', step: 'type' });
    const sourceRoute = value.snapshot.router.current.route;
    expect(value.externalDrafts).toEqual([
      expect.objectContaining({ kind: 'sourceDraft', owner: expect.any(String) }),
    ]);

    value.push({ name: 'operationHistory' });
    await nextTurn(2);
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual(sourceRoute);
    expect(value.hasSessionDraft).toBe(true);
    await input(instance, 'b');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    instance.unmount();
  });

  it('keeps all diagnostics and the oldest of 20 reports after a failed save at 60 × 18', async () => {
    const value = controller();
    const history = new OperationHistoryStore();
    history.record({
      summary: {
        recordId: '1:operation-1',
        epoch: 1,
        operationId: 'operation-1',
        createdAtMs: 1,
        state: 'partial',
        code: 'operationPartial',
        message: '部分目标没有完成。',
        diagnosticCount: 1,
        effects: {
          configCommit: 'completed',
          awWrite: 'partial',
          preApplyExternalEffect: 'possible',
          finalVerification: 'failed',
        },
      },
      diagnostics: [{
        id: '1:operation-1:target-0',
        code: 'preApplyExited',
        stage: 'preApply',
        safeMessage: '安装前检查没有完成。',
        target: { pluginId: 'official/target-0', platform: 'codex', scope: 'project' },
        causes: [{ code: 'EACCES', safeMessage: '服务报告 EACCES。' }],
        detailLines: ['安全详情第 1 行'],
      }],
      targets: Array.from({ length: 100 }, (_, index) => ({
        pluginId: `official/target-${index}`,
        platform: 'codex' as const,
        scope: 'project' as const,
        state: index === 0 ? 'failed' as const : 'completed' as const,
        ...(index === 0 ? { errorCode: 'preApplyExited', diagnosticIds: ['1:operation-1:target-0'] } : { diagnosticIds: [] }),
      })),
    });
    for (let index = 2; index <= 20; index += 1) {
      history.record({
        summary: {
          recordId: `1:operation-${index}`,
          epoch: 1,
          operationId: `operation-${index}`,
          createdAtMs: index,
          state: 'succeeded',
          code: 'operationSucceeded',
          message: `操作 ${index} 已完成。`,
          diagnosticCount: 0,
          effects: {
            configCommit: 'notApplicable',
            awWrite: 'completed',
            preApplyExternalEffect: 'notApplicable',
            finalVerification: 'completed',
          },
        },
        diagnostics: [],
        targets: [],
      });
    }
    value.attachOperationHistory(history, 1);
    value.push({ name: 'home' });
    const saveReport = vi.spyOn(value, 'saveOperationReport')
      .mockRejectedValueOnce(new Error('private write error'))
      .mockResolvedValueOnce({ path: '/private/tmp/operation-report.md' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    await input(instance, '?', 'o');
    expect(value.snapshot.router.current.route).toEqual({ name: 'operationHistory' });
    expect(instance.lastFrame()).toContain('操作 20 已完成。');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, ...Array.from({ length: 19 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('部分目标没有完成。');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('安全技术详情');
    expect(instance.lastFrame()).toContain('1 / 13');
    expect(instance.lastFrame()).toContain('official/target-0');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('State: partial');
    await input(instance, '\r', 'temporary-report-path');
    expect(instance.lastFrame()).toContain('temporary-report-path');
    expect(instance.lastFrame()).toContain('Ctrl-U 清空输入');
    expect(instance.lastFrame()).not.toContain('? 帮助');
    await input(instance, '?');
    expect(instance.lastFrame()).toContain('temporary-report-path?');
    expect(instance.lastFrame()).not.toContain('当前页快捷键');
    await input(instance, '\u0015');
    expect(instance.lastFrame()).not.toContain('temporary-report-path');
    await input(instance, '/tmp/operation-report.md', '\r');
    expect(saveReport).toHaveBeenCalledWith('1:operation-1', '/tmp/operation-report.md');
    expect(instance.lastFrame()).toContain('报告未保存');
    expect(instance.lastFrame()).not.toContain('private write error');
    expect(instance.lastFrame()).toContain('Record: 1:operation-1');
    expect(value.listOperationHistory()).toHaveLength(20);
    expect(value.previewOperationReport('1:operation-1')).toMatchObject({ recordId: '1:operation-1' });
    await input(instance, '\u001B[B', '\r');
    expect(saveReport).toHaveBeenLastCalledWith('1:operation-1');
    expect(instance.lastFrame()).toContain('报告已保存到临时目录');
    expect(instance.lastFrame()).not.toContain('/private/tmp/operation-report.md');

    value.replace({ name: 'result' });
    await nextTurn(2);
    await input(instance, 'o');
    expect(value.snapshot.router.current.route).toEqual({ name: 'operationHistory' });

    const issue = value.listUserIssues()[0]!;
    value.replace({ name: 'issueDetail', issueId: issue.issueId });
    await nextTurn(2);
    await input(instance, 'o');
    expect(value.snapshot.router.current.route).toEqual({ name: 'operationHistory' });
  });

  it.each([[60, 18], [80, 24]] as const)('copies complete safe operation text and keeps the reader at %ix%i', async (columns, rows) => {
    const clipboard = vi.mocked(copyToClipboard);
    clipboard.mockReset();
    clipboard.mockRejectedValueOnce(new Error('private clipboard error')).mockResolvedValueOnce(undefined);
    const value = controller();
    await value.load();
    const history = new OperationHistoryStore();
    const originalLine = `SAFE ${'unbroken'.repeat(18)} END_SENTINEL`;
    history.record({
      summary: {
        recordId: 'reader-1', epoch: 1, operationId: 'reader', createdAtMs: 1,
        state: 'blocked', code: 'operationBlocked', message: '操作受阻', diagnosticCount: 1,
        effects: { configCommit: 'notStarted', awWrite: 'notStarted',
          preApplyExternalEffect: 'notStarted', finalVerification: 'notStarted' },
      },
      diagnostics: [{ id: 'diagnostic-1', code: 'safeFailure', safeMessage: '安全原因',
        causes: [], detailLines: [originalLine, 'secret-value'] }],
      targets: Array.from({ length: 12 }, (_, index) => ({
        pluginId: `official/target-${index}`, platform: 'codex' as const,
        scope: 'project' as const, state: 'failed' as const, diagnosticIds: [],
      })),
    }, { sensitiveValues: ['secret-value'] });
    value.attachOperationHistory(history, 1);
    value.push({ name: 'operationDiagnostic', recordId: 'reader-1' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(3);
    const first = instance.lastFrame() ?? '';
    expect(first).toContain('[y] 复制全文');
    expect(first).not.toContain('p 上一页');
    await input(instance, '?', 'y');
    expect(clipboard).not.toHaveBeenCalled();
    await escape(instance);
    let pages = instance.lastFrame() ?? '';
    for (let page = 0; page < 30 && !pages.includes('NTINEL'); page += 1) {
      await input(instance, '\u001B[C');
      pages += `\n${instance.lastFrame() ?? ''}`;
    }
    expect(pages).toContain('END_SE');
    expect(pages).toContain('NTINEL');
    const atEnd = instance.lastFrame() ?? '';
    await input(instance, 'y');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('复制失败，请重试'));
    expect(instance.lastFrame()).toContain('NTINEL');
    expect(instance.lastFrame()).not.toContain('private clipboard error');
    await input(instance, 'y');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('全文已复制'));
    expect(instance.lastFrame()).toContain('NTINEL');
    expect(clipboard).toHaveBeenCalledTimes(2);
    expect(clipboard).toHaveBeenLastCalledWith(expect.stringContaining(originalLine));
    expect(clipboard.mock.lastCall?.[0]).toContain('[REDACTED]');
    expect(clipboard.mock.lastCall?.[0]).not.toContain('secret-value');
    expect(atEnd).toContain('NTINEL');
    await input(instance, '\u001B[D');
    expect(instance.lastFrame()).toContain('←→ 翻页');
  });
});
