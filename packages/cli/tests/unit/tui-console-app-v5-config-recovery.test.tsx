import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConsoleAppV4,
  type ConsoleV4ScreenId,
} from '../../src/tui/console-app-v4.js';
import {
  TuiConfigInvalidStoreError,
  type OperationEvidence,
  type OperationIntent,
} from '../../src/tui/controller.js';
import type { ConfigPageViewModel, ConfigReadOptions } from '../../src/tui/model.js';

vi.mock('../../src/tui/clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import {
  configPage,
  configPageForProfile,
  controller,
  deferred,
  evidence,
  evidenceForIntent,
  loadResult,
  objectConfigPage,
  updatePlacement,
} from '../helpers/tui-console-app-fixture.js';

import {
  acceptanceTraceStep,
  chooseConfigSave,
  chooseConfigProfile,
  confirmReview,
  escape,
  focusAction,
  focusBottomAction,
  input,
  nextTurn,
  openConfigSave,
  type AcceptanceTraceStep,
  writeAcceptanceTrace,
} from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

function configExecution(intent: OperationIntent, errorCode = 'runtimeApplyFailed') {
  if (intent.kind === 'configSaveBatch') return { status: 'succeeded', groups: intent.groups.map((group) => ({
    scope: 'user', platform: group.platform, status: 'succeeded', configSaved: true,
    applyRequested: false, applyStatus: 'notRequested',
  })) };
  if (errorCode === 'invalidConfig') return { configWrite: 'succeeded', overallState: 'partial',
    apply: { state: 'unavailable', reason: 'invalidConfig', targetResults: [] } };
  return { configWrite: 'succeeded', overallState: 'partial', apply: { state: 'partial', targetResults: [{
    target: { platform: 'codex', scope: 'user' }, state: 'failed', errorCode,
  }] } };
}

describe('ConsoleAppV4', () => {
  // Test Value Gate: an engine memory failure must retain its diagnostic code
  // and direct the user to restart, without offering source repair or reset.
  it.each(['common', 'codex', 'generic'] as const)(
    'shows restart recovery when configuration validation runs out of memory in %s settings', async (scope) => {
      const getConfigResetAvailability = vi.fn().mockResolvedValue({
        exists: true,
        state: 'ready',
        targetKind: 'regularFile',
        resettable: true,
      });
      const value = controller({
        getConfigResetAvailability,
        getConfigPage: vi.fn().mockRejectedValue(Object.assign(
          new Error('private engine details /Users/private'),
          { code: 'configValidationMemoryExhausted' },
        )),
      });
      await value.load();
      value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
      value.beginConfigFlow('team-tools/review-gate');
      value.replace({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { profile: scope, context: 'user' } });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 40 }} />);
      await nextTurn(5);
      expect(value.snapshot.router.current.route).toMatchObject({
        name: 'configUnavailable',
        diagnosticCode: 'configValidationMemoryExhausted',
        diagnosticStage: 'read-config',
      });
      expect(instance.lastFrame()).toContain('设置校验内存不足');
      expect(instance.lastFrame()).toContain('重新启动 AW');
      expect(instance.lastFrame()).toContain('已保存的设置保持不变');
      expect(instance.lastFrame()).not.toContain('修复插件来源');
      expect(instance.lastFrame()).not.toContain('重置');
      expect(instance.lastFrame()).not.toContain('手动移动');
      expect(getConfigResetAvailability).not.toHaveBeenCalled();
      await focusAction(instance, '技术详情');
      await input(instance, '\r');
      expect(instance.lastFrame()).toContain('configValidationMemoryExhausted');
      expect(instance.lastFrame()).not.toContain('/Users/private');
    },
  );

  it('renders config partial retry, reset Review, unavailable terminal state, and compact field viewport', async () => {
    const partialScreens = new Set<ConsoleV4ScreenId>();
    const partialReload = loadResult();
    const failedTarget = partialReload.payload.targets.find((entry) =>
      entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'claude'
      && entry.scope === 'user');
    if (failedTarget) updatePlacement(failedTarget, 'user', {
      state: 'needsSync',
      reasons: [{ code: 'missingContent', message: '安全说明', severity: 'warning' }],
    });
    const partial = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(loadResult()).mockResolvedValue(partialReload),
      getConfigPage: vi.fn(async (pluginId, options) => configPage(pluginId, options)),
      executeIntent: vi.fn(async (intent: OperationIntent) => configExecution(intent, 'runtimeApplyFailed')),
    });
    await partial.load();
    partial.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    partial.beginConfigFlow('team-tools/review-gate');
    partial.replace({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { profile: 'common', context: 'user' } });
    const partialInstance = render(<ConsoleAppV4 controller={partial} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => partialScreens.add(screen)} />);
    await nextTurn(4);
    await input(partialInstance, '\u001B[B', '\r', '\u001B[B', '\r');
    await openConfigSave(partialInstance, partial);
    await chooseConfigSave(partialInstance, partial, 'apply');
    await confirmReview(partialInstance, partial);
    await nextTurn(4);
    expect(partialScreens).toContain('C13');
    expect(partialInstance.lastFrame()).toContain('部分应用失败');
    expect(partialInstance.lastFrame()).toContain('重试应用');

    const resetScreens = new Set<ConsoleV4ScreenId>();
    const reset = controller({ getConfigPage: vi.fn(async (pluginId, options) => configPage(pluginId, options)) });
    reset.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { profile: 'codex', context: 'project' } });
    const resetInstance = render(<ConsoleAppV4 controller={reset} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => resetScreens.add(screen)} />);
    await nextTurn(4);
    await focusAction(resetInstance, '设置选项');
    await input(resetInstance, '\r');
    await focusAction(resetInstance, '恢复默认值');
    await input(resetInstance, '\r');
    await nextTurn(3);
    expect(resetScreens).toContain('C22');
    expect(resetInstance.lastFrame()).toContain('Codex 平台配置');
    await input(resetInstance, 'd');
    let resetReviewFrames = resetInstance.lastFrame() ?? '';
    for (let page = 0; page < 12 && !resetReviewFrames.includes('其他平台设置保持不变'); page += 1) {
      await input(resetInstance, '\u001B[C');
      resetReviewFrames += `\n${resetInstance.lastFrame() ?? ''}`;
    }
    expect(reset.snapshot.activeReview?.operationKind).toBe('configReset');

    const unavailableScreens = new Set<ConsoleV4ScreenId>();
    const unavailable = controller({
      getConfigPage: vi.fn().mockRejectedValue(new Error('catalogSourceUnavailable: private manifest error /Users/private')),
    });
    await unavailable.load();
    unavailable.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    unavailable.beginConfigFlow('team-tools/review-gate');
    unavailable.replace({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { profile: 'common', context: 'user' } });
    const unavailableInstance = render(<ConsoleAppV4 controller={unavailable} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => unavailableScreens.add(screen)} />);
    await nextTurn(5);
    expect(unavailableScreens).toContain('C21');
    expect(unavailableInstance.lastFrame()).toContain('插件定义或来源不可用');
    expect(unavailableInstance.lastFrame()).toContain('修复插件来源');
    expect(unavailableInstance.lastFrame()).not.toContain('aw source sync team-tools');
    expect(unavailableInstance.lastFrame()).not.toContain('/Users/private');
    expect(unavailableInstance.lastFrame()).not.toContain('重置此设置层');
    await input(unavailableInstance, '\r');
    await nextTurn(4);
    expect(unavailable.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'team-tools' });

    const longPage = configPage();
    longPage.presets = [];
    longPage.groups = [{
      id: 'long',
      title: '长设置组',
      advanced: false,
      fields: Array.from({ length: 12 }, (_, index) => ({
        ...longPage.groups[0]!.fields[3]!,
        key: `field-${index + 1}`,
        title: `字段 ${index + 1}`,
      })),
    }];
    const compact = controller({ getConfigPage: vi.fn(async (_pluginId, options) => configPageForProfile(longPage, options)) });
    compact.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { profile: 'common', context: 'user' } });
    const compactInstance = render(<ConsoleAppV4 controller={compact} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    await input(compactInstance, ...Array.from({ length: 8 }, () => '\u001B[B'));
    const compactFrame = compactInstance.lastFrame() ?? '';
    expect(compactFrame).toContain('› 字段 9');
    expect(compactFrame).not.toContain('字段 1\n');
    expect(compactFrame).not.toContain('保存并应用');
    await focusBottomAction(compactInstance, '设置选项');
    await input(compactInstance, '\r');
    await focusAction(compactInstance, '恢复默认值');
    expect(compactInstance.lastFrame()).toContain('› 恢复默认值');
    expect(compactFrame.split('\n').length).toBeLessThanOrEqual(18);

    const effective = controller({ getConfigPage: vi.fn(async (_pluginId, options) => configPageForProfile(longPage, options)) });
    effective.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { profile: 'common', context: 'user' } });
    const effectiveInstance = render(<ConsoleAppV4 controller={effective} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    await input(effectiveInstance, ...Array.from({ length: 8 }, () => '\u001B[B'));
    expect(effectiveInstance.lastFrame()).toContain('字段 9');
    expect(effectiveInstance.lastFrame()).toContain('› 字段 9');
    expect((effectiveInstance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
  });

  it('opens source-missing saved settings from the user document when their source is missing', async () => {
    const loaded = loadResult();
    loaded.configStoreInventory = [{
      pluginId: 'team-tools/retired-settings',
      sourceId: 'team-tools',
      pluginName: 'retired-settings',
      scope: 'user',
    }];
    const getConfigResetAvailability = vi.fn().mockResolvedValue({
      exists: true,
      state: 'invalid',
      sourceIdentityPresent: false,
      targetKind: 'regularFile',
      resettable: true,
    });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      getConfigResetAvailability,
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/retired-settings' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    expect(instance.lastFrame()).toContain('查看已保存设置');
    expect(instance.lastFrame()).toContain('恢复插件来源');
    expect(instance.lastFrame()).not.toContain('添加到');
    await focusAction(instance, '查看已保存设置');
    await input(instance, '\r');
    await nextTurn(3);

    expect(value.snapshot.router.current.route).toEqual({
      name: 'configUnavailable',
      pluginId: 'team-tools/retired-settings',
      storedScopes: ['user'],
      layer: { profile: 'common', context: 'user' },
      diagnosticCode: 'catalogSourceUnavailable',
      diagnosticStage: 'read-config',
    });
    expect(getConfigResetAvailability).toHaveBeenCalledWith(
      'team-tools/retired-settings',
      expect.objectContaining({ context: 'user' }),
      expect.any(AbortSignal),
    );
    expect(instance.lastFrame()).toContain('重置公共设置');
    expect(instance.lastFrame()).not.toContain('重置当前项目');
    expect(instance.lastFrame()).not.toContain('修复插件来源');
  });

  it.each([
    { columns: 80, rows: 24 },
    { columns: 60, rows: 18 },
  ])('offers invalid-layer reset through Review and keeps its details private at $columns x $rows', async (size) => {
    const sourceIdentity = `sha256:${'a'.repeat(64)}`;
    const storeDigest = `sha256:${'b'.repeat(64)}`;
    const value = controller({
      getConfigResetAvailability: vi.fn().mockResolvedValue({
        exists: true,
        state: 'invalid',
        invalidCode: 'invalidJson',
        sourceIdentityPresent: true,
        sourceIdentity,
        storeDigest,
      }),
      captureEvidence: vi.fn().mockResolvedValue({
        ...evidence,
        source: { sourceId: 'team-tools', sourceIdentity },
        config: { scope: 'user', storeDigest, affectedTargets: [] },
      }),
    });
    await value.load();
    value.push({
      name: 'configUnavailable',
      pluginId: 'team-tools/review-gate',
      layer: { profile: 'common', context: 'user' },
      invalidStores: [{
        scope: 'user',
        code: 'invalidJson',
        pathSummary: 'AW_HOME/plugin-config/team-tools/review-gate/config.json',
      }],
      diagnosticCode: 'invalidJson',
      diagnosticStage: 'read-config',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('重置公共设置');
    expect(instance.lastFrame()).not.toContain('查看安全路径摘要');
    expect(instance.lastFrame()).not.toContain(sourceIdentity);
    expect(instance.lastFrame()).not.toContain(storeDigest);
    expect(instance.lastFrame()).not.toContain('/Users/private');
    expect(instance.lastFrame()).not.toContain('invalidJson');
    await input(instance, 'd');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('invalidJson');
    expect(technicalFrame).toContain('read-config');
    expect(technicalFrame).not.toContain(sourceIdentity);
    expect(technicalFrame).not.toContain(storeDigest);
    await input(instance, '\r');
    await nextTurn(4);
    expect(value.snapshot.activeReview?.operationKind).toBe('configReset');
    expect(instance.lastFrame()).toContain('重置插件设置');
  });

  it('does not offer an automatic reset when the user document cannot be inspected safely', async () => {
    const value = controller({ getConfigResetAvailability: vi.fn().mockRejectedValue(new Error('unsafe config ancestor')) });
    value.push({ name: 'configUnavailable', pluginId: 'team-tools/review-gate',
      layer: { profile: 'codex', context: 'project' }, invalidStores: [{ scope: 'user', code: 'invalidJson',
        pathSummary: 'AW_HOME/plugin-config/team-tools/review-gate/config.json' }] });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />); await nextTurn(4);
    expect(instance.lastFrame()).not.toContain('重置Codex');
    expect(instance.lastFrame()).toContain('技术详情');
    expect(instance.lastFrame()).not.toContain('unsafe config ancestor');
  });

  it('shows a special reset target as manual recovery without an automatic action', async () => {
    const value = controller({
      getConfigResetAvailability: vi.fn().mockResolvedValue({
        exists: true,
        state: 'invalid',
        sourceIdentityPresent: false,
        targetKind: 'special',
        resettable: false,
        storeDigest: 'sha256:special',
      }),
    });
    value.push({
      name: 'configUnavailable',
      pluginId: 'team-tools/review-gate',
      invalidStores: [{
        scope: 'user', code: 'invalidValues',
        pathSummary: 'AW_HOME/plugin-config/team-tools/review-gate/config.json',
      }],
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('公共设置不能自动重置');
    expect(instance.lastFrame()).toContain('特殊节点，请手动移动');
    expect(instance.lastFrame()).not.toContain('重置公共设置');
  });

  it.each(['common', 'codex', 'generic'] as const)(
    'binds an invalid shared user document to the selected %s profile without a project store reset', async (profile) => {
      const invalidStores = [{ scope: 'user' as const, code: 'invalidJson' as const,
        pathSummary: 'AW_HOME/plugin-config/team-tools/review-gate/config.json' }];
      const getConfigResetAvailability = vi.fn().mockResolvedValue({ exists: true, state: 'invalid', invalidCode: 'invalidJson',
        sourceIdentityPresent: true, sourceIdentity: 'identity:user', storeDigest: 'digest:user', resettable: true });
      const captureEvidence = vi.fn().mockResolvedValue(evidence);
      const value = controller({ getConfigPage: vi.fn().mockRejectedValue(new TuiConfigInvalidStoreError(invalidStores)),
        getConfigResetAvailability, captureEvidence });
      value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { profile, context: 'project' } });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />); await nextTurn(6);
      expect(value.snapshot.router.current.route).toMatchObject({ name: 'configUnavailable', layer: { profile, context: 'project' }, invalidStores });
      expect(instance.lastFrame()).not.toContain('重置当前项目');
      expect(instance.lastFrame()?.match(/› 重置/gu)).toHaveLength(1);
      expect(getConfigResetAvailability).toHaveBeenCalledOnce();
      expect(getConfigResetAvailability.mock.calls[0]![1]).toMatchObject({ context: 'project' });
      await input(instance, '\r'); await nextTurn(4);
      expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({ kind: 'configReset', scope: 'user', context: 'project',
        ...(profile === 'common' ? {} : { platform: profile }) }), expect.any(AbortSignal));
    },
  );

  it('does not let an aborted common response overwrite the active Codex page', async () => {
    const pending = deferred<ConfigPageViewModel>();
    const activePage = configPage('team-tools/review-gate', { platform: 'codex' });
    activePage.groups[0]!.fields[0]!.effectiveDisplayValue = '当前Codex标记';
    const value = controller({ getConfigPage: vi.fn((_pluginId, options) => options.platform === undefined
      ? pending.promise : Promise.resolve(configPageForProfile(activePage, options))) });
    value.push({ name: 'configFields', pluginId: activePage.pluginId, layer: { profile: 'common', context: 'user' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />); await nextTurn(4);
    await chooseConfigProfile(instance, value, 'codex');
    expect(instance.lastFrame()).toContain('当前Codex标记');
    const oldPage = configPage(); oldPage.groups[0]!.fields[0]!.effectiveDisplayValue = '过期公共标记'; pending.resolve(oldPage);
    await nextTurn(5);
    expect(instance.lastFrame()).toContain('当前Codex标记'); expect(instance.lastFrame()).not.toContain('过期公共标记');
  });

  it('keeps the config group and field viewport when config loading enters source recovery', async () => {
    const value = controller({
      getConfigPage: vi.fn().mockRejectedValue(Object.assign(
        new Error('catalogSourceUnavailable'),
        { code: 'catalogSourceUnavailable' },
      )),
    });
    value.push({
      name: 'configFieldAction',
      pluginId: 'team-tools/review-gate',
      layer: { profile: 'common', context: 'user' },
      fieldKey: 'model',
    }, { configGroupId: 'advanced', focusIndex: 2, scrollOffset: 1 });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configUnavailable',
      resumeRoute: {
        name: 'configFieldAction',
        pluginId: 'team-tools/review-gate',
        layer: { profile: 'common', context: 'user' },
        fieldKey: 'model',
      },
      resumeContext: { configGroupId: 'advanced', focusIndex: 2, scrollOffset: 1 },
    });
    expect(instance.lastFrame()).toContain('修复插件来源');
  });

  it('uses G04 when leaving a dirty config layer and can discard its draft', async () => {
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({ getConfigPage: vi.fn(async (pluginId, options) => configPage(pluginId, options)) });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { profile: 'common', context: 'user' } });
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => screens.add(screen)}
      onSessionNavigation={async (navigation, options) => {
        if (value.hasSessionDraft && !options?.discardDrafts) return 'draftBlocked' as const;
        if (navigation === 'home') value.goHome(options);
        return 'completed' as const;
      }}
    />);
    await nextTurn(4);
    await input(instance, '\r');
    await focusAction(instance, '快速');
    await input(instance, '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(value.hasSessionDraft).toBe(true);
    await input(instance, 'h');
    await nextTurn(2);
    expect(screens).toContain('G04');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    await input(instance, '\u001B[B', '\r');
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toEqual({ name: 'home' });
  });

  it('keeps a config draft when h defaults to continue editing', async () => {
    const value = controller({ getConfigPage: vi.fn(async (pluginId, options) => configPage(pluginId, options)) });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { profile: 'common', context: 'user' } });
    const onSessionNavigation = vi.fn(async (
      _navigation: 'home' | 'reload',
      options?: { discardDrafts?: boolean },
    ) => value.hasSessionDraft && !options?.discardDrafts ? 'draftBlocked' as const : 'completed' as const);
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onSessionNavigation={onSessionNavigation}
    />);
    await nextTurn(4);
    await input(instance, '\r', '\u001B[B', '\r');
    await nextTurn(3);
    await input(instance, '\u001B[B', '\r');
    await nextTurn(2);
    expect(value.hasSessionDraft).toBe(true);
    const draftRoute = value.snapshot.router.current.route;

    await input(instance, 'h');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    expect(instance.lastFrame()).toContain('继续编辑');
    await input(instance, '\r');

    expect(value.hasSessionDraft).toBe(true);
    expect(value.snapshot.router.current.route).toEqual(draftRoute);
  });

  it('returns from read-only history without discarding or confirming the parent config draft', async () => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, options) => configPage(pluginId, options)),
    });
    const recordId = value.recordUiFailure(undefined, { code: 'fixtureFailure', stage: 'fixture-stage' });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { profile: 'common', context: 'user' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\r', '\u001B[B', '\r');
    expect(value.hasSessionDraft).toBe(true);
    const draftRoute = value.snapshot.router.current.route;

    await input(instance, '?', 'o');
    expect(value.snapshot.router.current.route).toEqual({ name: 'operationHistory' });
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'operationDiagnostic', recordId });
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'operationReportPreview', recordId });
    await input(instance, 'b', 'b', 'b');

    expect(value.snapshot.router.current.route).toEqual(draftRoute);
    expect(value.hasSessionDraft).toBe(true);
    expect(instance.lastFrame()).not.toContain('放弃未保存修改？');
    instance.unmount();
  });

  it('keeps an object draft through read-only history and guards the real config-flow exit', async () => {
    const page = objectConfigPage();
    const value = controller({ getConfigPage: vi.fn(async (_pluginId, options) => configPageForProfile(page, options)) });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { profile: 'common' } });
    value.push({ name: 'configFieldEditor', pluginId: page.pluginId, layer: { profile: 'common' }, fieldKey: 'settings', editor: 'object', mode: 'custom' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />); await nextTurn(5);
    await focusAction(instance, '负责人'); await input(instance, '\r', '\r', '\u0015', 'DraftOwner', '\r');
    await focusAction(instance, '使用此完整对象'); await input(instance, '\r'); await nextTurn(3);
    const draftRoute = value.snapshot.router.current.route;
    expect(value.externalDrafts).toEqual([expect.objectContaining({ kind: 'configDraft', owner: page.pluginId })]);
    value.push({ name: 'operationHistory' }); await nextTurn(2); await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual(draftRoute); expect(value.hasSessionDraft).toBe(true);
    await input(instance, 'b'); expect(instance.lastFrame()).toContain('放弃未保存修改？');
    instance.unmount();
  });

  it('keeps a recovered source draft visible and blocks a field removed by the new schema', async () => {
    const initialPage = configPage();
    const refreshedPage = configPage();
    refreshedPage.groups[0]!.fields = refreshedPage.groups[0]!.fields
      .filter((field) => field.key !== 'level');
    let useRefreshedPage = false;
    const getConfigPage = vi.fn(async (pluginId: string, options: ConfigReadOptions) => configPageForProfile({
      ...(useRefreshedPage ? refreshedPage : initialPage), pluginId,
    }, options));
    const value = controller({ getConfigPage });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    value.beginConfigFlow('team-tools/review-gate');
    value.replace({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { profile: 'common', context: 'user' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\r', '\u001B[B', '\r');
    await nextTurn(3);
    await input(instance, '\u001B[B', '\r');
    expect(value.hasSessionDraft).toBe(true);

    const resumeRoute = {
      name: 'configFields' as const,
      pluginId: 'team-tools/review-gate',
      layer: { profile: 'common' as const, context: 'user' as const },
    };
    value.replace({
      name: 'configUnavailable',
      pluginId: 'team-tools/review-gate',
      diagnosticCode: 'catalogSourceUnavailable',
      diagnosticStage: 'read-config',
      resumeRoute,
    });
    await nextTurn(2);
    useRefreshedPage = true;
    value.replace(resumeRoute);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('有未保存修改无法继续使用');
    expect(instance.lastFrame()).toContain('1 项待保存');
    expect(value.hasSessionDraft).toBe(true);
    await input(instance, 's');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).toContain('有未保存修改无法继续使用');
  });

  it('returns a dirty source recovery to its field and blocks a now-unwritable draft', async () => {
    const loaded = loadResult();
    loaded.catalogGenerations = loaded.catalogGenerations?.map((generation) =>
      generation.sourceId === 'team-tools'
        ? { ...generation, state: 'repairRequired' as const }
        : generation);
    const initialPage = configPage();
    const refreshedPage = configPage();
    const refreshedLevel = refreshedPage.groups[0]!.fields.find((field) => field.key === 'level')!;
    refreshedLevel.writable = false;
    refreshedLevel.canSet = false;
    refreshedLevel.canUnset = false;
    let useRefreshedPage = false;
    const getConfigPage = vi.fn(async (pluginId: string, options: ConfigReadOptions) => configPageForProfile({
      ...(useRefreshedPage ? refreshedPage : initialPage), pluginId,
    }, options));
    const captureEvidence = vi.fn(async (intent: OperationIntent) => {
      const prepared = evidenceForIntent(intent);
      return intent.kind === 'catalogGeneration' && prepared.catalogGeneration
        ? {
            ...prepared,
            catalogGeneration: {
              ...prepared.catalogGeneration,
              exactRepair: intent.action === 'repair',
              activationMode: 'normal' as const,
            },
          }
        : prepared;
    });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      getConfigPage,
      captureEvidence,
      executeIntent: vi.fn().mockResolvedValue({ status: 'succeeded' }),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    value.beginConfigFlow('team-tools/review-gate');
    value.replace({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { profile: 'common', context: 'user' },
    }, { configGroupId: 'basic', focusIndex: 0, scrollOffset: 0 });
    const overviewFrameId = value.snapshot.router.currentFrameId;
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\r', '\r', '\r');
    await nextTurn(3);
    await input(instance, '\u001B[B', '\r');
    await nextTurn(2);
    expect(value.hasSessionDraft).toBe(true);

    const resumeRoute = {
      name: 'configFieldEditor' as const, editor: 'string' as const,
      pluginId: 'team-tools/review-gate',
      layer: { profile: 'common' as const, context: 'user' as const },
      fieldKey: 'level',
    };
    value.replace({
      name: 'configUnavailable',
      pluginId: 'team-tools/review-gate',
      overviewFrameId,
      layer: { profile: 'common', context: 'user' },
      diagnosticCode: 'catalogSourceUnavailable',
      diagnosticStage: 'read-config',
      resumeRoute,
      resumeContext: { configGroupId: 'basic', focusIndex: 0, scrollOffset: 0 },
    }, { configGroupId: 'basic', focusIndex: 0, scrollOffset: 0 });
    await nextTurn(2);

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'team-tools' });
    expect(instance.lastFrame()).toContain('恢复来源');
    await input(instance, 'a', '\r');
    await nextTurn(4);
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'catalogGeneration', action: 'repair', sourceId: 'team-tools',
    }), expect.any(AbortSignal));
    await confirmReview(instance, value);
    await nextTurn(6);
    expect(value.snapshot.router.current.route.name).toBe('result');

    await input(instance, 'h');
    expect(value.snapshot.router.current.route.name).toBe('result');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    expect(value.hasSessionDraft).toBe(true);
    useRefreshedPage = true;
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('继续编辑未保存设置');
    await input(instance, '\r');
    await nextTurn(4);
    expect(value.snapshot.router.current.route).toEqual(resumeRoute);
    expect(value.snapshot.router.current.context).toMatchObject({
      configGroupId: 'basic', focusIndex: 0, scrollOffset: 0,
    });
    expect(value.hasSessionDraft).toBe(true);

    await input(instance, 'b');
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('有未保存修改无法继续使用');
    expect(instance.lastFrame()).toContain('设置内容或可用位置已变化');
    expect(instance.lastFrame()).toContain('1 项待保存');
    await input(instance, 's');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).toContain('有未保存修改无法继续使用');
  });

  it('keeps one anchored config overview through source recovery and guards its original exit', async () => {
    const loaded = loadResult();
    loaded.catalogGenerations = loaded.catalogGenerations?.map((generation) =>
      generation.sourceId === 'team-tools'
        ? { ...generation, state: 'repairRequired' as const }
        : generation);
    const initialRead = deferred<ConfigPageViewModel>();
    let recovered = false;
    const getConfigPage = vi.fn((pluginId: string, options: ConfigReadOptions) => recovered
      ? Promise.resolve(configPage(pluginId, options))
      : initialRead.promise);
    const captureEvidence = vi.fn(async (intent: OperationIntent) => {
      const prepared = evidenceForIntent(intent);
      return intent.kind === 'catalogGeneration' && prepared.catalogGeneration
        ? {
            ...prepared,
            catalogGeneration: {
              ...prepared.catalogGeneration,
              exactRepair: intent.action === 'repair',
              activationMode: 'normal' as const,
            },
          }
        : prepared;
    });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      getConfigPage,
      captureEvidence,
      executeIntent: vi.fn().mockResolvedValue({ status: 'succeeded' }),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const detailFrameId = value.snapshot.router.currentFrameId;
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await focusAction(instance, '插件设置');
    await input(instance, '\r');
    const overviewFrameId = value.snapshot.router.currentFrameId;
    const configFlowId = value.snapshot.router.currentFlowId;
    initialRead.reject(new Error('catalogSourceUnavailable: unavailable fixture'));
    await nextTurn(4);
    expect(value.snapshot.router.current.route.name).toBe('configUnavailable');
    expect(value.snapshot.router.currentFlowId).toBe(configFlowId);

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'team-tools' });
    await input(instance, 'b');
    expect(value.snapshot.router.current.route.name).toBe('configUnavailable');
    await input(instance, '\r', 'a', '\r');
    await nextTurn(4);
    await confirmReview(instance, value);
    await nextTurn(6);
    expect(value.snapshot.router.current.route.name).toBe('result');

    recovered = true;
    await escape(instance);
    await nextTurn(4);
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(value.snapshot.router.currentFrameId).toBe(overviewFrameId);
    expect(value.snapshot.router.currentFlowId).toBe(configFlowId);

    await input(instance, '\r', '\u001B[B', '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(value.snapshot.router.currentFrameId).toBe(overviewFrameId);
    expect(value.snapshot.router.currentFlowId).toBe(configFlowId);
    expect(value.hasSessionDraft).toBe(true);

    await input(instance, 'b');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'team-tools/review-gate',
    });
    expect(value.snapshot.router.currentFrameId).toBe(detailFrameId);
    expect(value.hasSessionDraft).toBe(false);
    instance.unmount();
  });

  it.each([[60, 18], [80, 24]] as const)(
    'submits every field change with the complete final before-after values at %ix%i', async (columns, rows) => {
      const page = configPage();
      const final = page.groups[0]!.fields[2]!;
      Object.assign(final, { title: '最后设置字段', value: '设置最后修改前唯一值', draftValue: '设置最后修改前唯一值',
        displayValue: '设置最后修改前唯一值', type: 'string', definition: { type: 'string' },
        fallbackDisplayValue: '设置最后修改后唯一值', fallbackSourceLabel: '公共配置' });
      const captureEvidence = vi.fn(async (intent: OperationIntent) => evidenceForIntent(intent));
      const value = controller({ getConfigPage: vi.fn(async (_pluginId, options) => configPageForProfile(page, options)), captureEvidence });
      value.push({ name: 'configFields', pluginId: page.pluginId, layer: { profile: 'codex', context: 'project' } });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />); await nextTurn(5);
      await input(instance, '\r', '\u0012');
      await input(instance, '\u001b[B', '\u001b[B', '\r', '\u0012');
      await input(instance, '\u001b[A', '\r', '\u0012');
      expect(instance.lastFrame()).toContain('3 项待保存');
      await openConfigSave(instance, value);
      expect(captureEvidence.mock.calls[0]![0]).toMatchObject({ kind: 'configSaveBatch', apply: false, context: 'project', groups: [
        expect.objectContaining({ scope: 'user', platform: 'codex', removeKeys: expect.arrayContaining(['level', 'enabled', 'timeout']),
          changes: expect.arrayContaining([expect.objectContaining({ key: 'timeout', title: '最后设置字段',
            before: '设置最后修改前唯一值', after: '恢复继承（设置最后修改后唯一值 · 公共配置）' })]) }),
      ] });
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
      await writeAcceptanceTrace(`config-save/multi-field-${columns}x${rows}`,
        [acceptanceTraceStep(instance, { columns, rows }, '全部修改已保存后选择更新', ['Ctrl-R', 's'])]);
    },
  );

  it('shows a committed config write with one failed target as partial', async () => {
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, options) => configPage(pluginId, options)),
      executeIntent: vi.fn(async (intent: OperationIntent) => configExecution(intent, 'runtimeApplyFailed')),
    });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { profile: 'common', context: 'user' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { profile: 'common', context: 'user' },
      fieldKey: 'note',
      editor: 'string',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);
    await input(instance, 'DRAFT-KEEP', '\r');

    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'apply');
    await confirmReview(instance, value);
    await nextTurn(4);

    expect(value.snapshot.result).toMatchObject({ state: 'partial' });
    expect(value.snapshot.router.current.route.name).toBe('result');
    expect(instance.lastFrame()).toContain('设置已保存，但部分应用失败');
    expect(instance.lastFrame()).toContain('所有项目');
    expect(instance.lastFrame()).toContain('重试应用');
    expect(instance.lastFrame()).toContain('返回修改');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    expect(screens).toContain('C13');
    await input(instance, '\r');
    await nextTurn(4);
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(instance.lastFrame()).toContain('更新已有插件内容');
  });

  it('shows a saved invalid config as unapplied instead of an apply failure', async () => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, options) => configPage(pluginId, options)),
      executeIntent: vi.fn(async (intent: OperationIntent) => configExecution(intent, 'invalidConfig')),
    });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { profile: 'common', context: 'user' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { profile: 'common', context: 'user' },
      fieldKey: 'note',
      editor: 'string',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, 'SAVED', '\r');

    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'apply');
    await confirmReview(instance, value);
    await nextTurn(4);

    expect(value.snapshot.result).toMatchObject({
      state: 'partial',
      summary: { configApplied: false },
    });
    expect(instance.lastFrame()).toContain('设置已保存，但未应用');
    expect(instance.lastFrame()).toContain('当前配置仍无效');
    expect(instance.lastFrame()).not.toContain('部分应用失败');
    expect(instance.lastFrame()).not.toContain('重试应用');
    expect(instance.lastFrame()).not.toContain('cleanup');
    expect(instance.lastFrame()).not.toContain('reinstall');
    expect(instance.lastFrame()).not.toContain('sync');
  });

  it.each([
    ['absent', '设置层原本不存在；没有删除内容', undefined],
    ['deletedFile', '已删除设置文件', undefined],
    ['unlinkedSymlink', '已解除设置路径符号链接；链接目标未修改', undefined],
    ['quarantinedDirectory', '设置路径是目录；已隔离为 config.broken-safe.json', 'config.broken-safe.json'],
  ] as const)('renders the safe %s reset result at 60x18', async (
    resetDisposition,
    expected,
    quarantineBasename,
  ) => {
    const value = controller({
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'succeeded',
        apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
        resetDisposition,
        ...(quarantineBasename ? { quarantineBasename } : {}),
      }),
    });
    const review = await value.buildOperationReview({
      kind: 'configReset',
      pluginId: 'team-tools/review-gate',
      scope: 'user',

    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain(expected);
    expect(frame).not.toContain('/Users/private');
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('settles config result cleanup without repeated snapshot publications', async () => {
    const value = controller({
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'succeeded',
        apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
      }),
    });
    const review = await value.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team-tools/review-gate',
      scope: 'user',

      apply: false,
      updates: { mode: 'safe' },
    });
    await value.executeOperation(review.reviewToken);
    let publicationCount = 0;
    const unsubscribe = value.subscribe(() => {
      publicationCount += 1;
    });
    render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(8);
    const settledPublicationCount = publicationCount;

    await nextTurn(12);

    expect(value.snapshot.router.current.route.name).toBe('result');
    expect(publicationCount).toBe(settledPublicationCount);
    unsubscribe();
  });

  it('requires explicit confirmation before a shared native config retry executes', async () => {
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'succeeded', targetResults: [],
    });
    const value = controller({
      captureEvidence: vi.fn().mockResolvedValue({
        ...evidence,
        config: {
          scope: 'user',
          schemaIdentity: 'sha256:schema',
          storeDigest: 'sha256:store',
          affectedTargets: [{ platform: 'codex', scope: 'user' }],
          sharedNativeRenderTargets: [{
            id: 'explore', skillKey: 'codex-explore', refreshKeys: ['exploreWait'],
          }],
        },
      }),
      executeIntent,
    });
    await value.buildOperationReview({
      kind: 'configSave', pluginId: 'official/enhance', scope: 'user',
      apply: true, retryApply: true,
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('更新已有插件内容');
    await input(instance, '\r');
    expect(executeIntent).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('返回检查');
    expect(instance.lastFrame()).toContain('确认更新已有插件内容');
    expect(instance.lastFrame()).not.toContain('独立授权');
    instance.rerender(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('返回检查');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    instance.rerender(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await input(instance, '\u0003');
    expect(instance.lastFrame()).toContain('退出控制台？');
    expect(executeIntent).not.toHaveBeenCalled();
    await input(instance, '\r', '\r');
    expect(instance.lastFrame()).toContain('返回检查');
    await input(instance, 'q');
    expect(instance.lastFrame()).toContain('退出控制台？');
    expect(executeIntent).not.toHaveBeenCalled();
    await input(instance, '\r', '\r');
    expect(instance.lastFrame()).toContain('返回检查');
    await input(instance, '\r');
    expect(executeIntent).not.toHaveBeenCalled();
    await input(instance, '\r', '\u001B[B', '\r');
    await nextTurn(3);
    expect(executeIntent).toHaveBeenCalledOnce();
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'configSave', retryApply: true,
    }), expect.anything());
  });

  it('[review/shared-risk/stale] invalidates an open risk confirmation when a new Review token replaces it', async () => {
    const intent = {
      kind: 'configSave' as const,
      pluginId: 'official/enhance',
      scope: 'user' as const,
      apply: true,
      retryApply: true,
    };
    const executeIntent = vi.fn();
    const value = controller({
      captureEvidence: vi.fn().mockResolvedValue({
        ...evidence,
        config: {
          scope: 'user', schemaIdentity: 'sha256:schema', storeDigest: 'sha256:store',
          affectedTargets: [{ platform: 'codex', scope: 'user' }],
          sharedNativeRenderTargets: [{
            id: 'explore', skillKey: 'codex-explore', refreshKeys: ['exploreWait'],
          }],
        },
      }),
      executeIntent,
    });
    await value.buildOperationReview(intent);
    const firstToken = value.snapshot.activeReview!.reviewToken;
    const standardSize = { columns: 80, rows: 24 };
    const compactSize = { columns: 60, rows: 18 };
    const instance = render(<ConsoleAppV4 controller={value} size={standardSize} />);
    const trace: AcceptanceTraceStep[] = [];
    await nextTurn(2);
    trace.push(acceptanceTraceStep(instance, standardSize, '共享风险 Review', []));
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('返回检查');
    trace.push(acceptanceTraceStep(instance, standardSize, '风险弹窗默认安全焦点', ['Enter']));

    instance.rerender(<ConsoleAppV4 controller={value} size={compactSize} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('返回检查');
    trace.push(acceptanceTraceStep(instance, compactSize, '缩窄后风险与安全焦点保留', ['resize 60x18']));

    await escape(instance);
    expect(instance.lastFrame()).not.toContain('返回检查');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('返回检查');

    await value.buildOperationReview(intent);
    await nextTurn(3);
    expect(value.snapshot.activeReview!.reviewToken).not.toBe(firstToken);
    expect(instance.lastFrame()).not.toContain('独立授权');
    instance.rerender(<ConsoleAppV4 controller={value} size={standardSize} />);
    await nextTurn(2);
    trace.push(acceptanceTraceStep(instance, standardSize, '新证据撤销旧弹窗并恢复宽屏', ['new review token', 'resize 80x24']));
    await input(instance, '\r');
    expect(executeIntent).not.toHaveBeenCalled();
    trace.push(acceptanceTraceStep(instance, standardSize, '新 Review 需要重新确认', ['Enter']));
    await writeAcceptanceTrace('review/shared-risk/stale', trace);
  });

  it('executes an ordinary config retry without shared confirmation', async () => {
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'succeeded', targetResults: [],
    });
    const value = controller({
      captureEvidence: vi.fn().mockResolvedValue({
        ...evidence,
        config: {
          scope: 'user',
          schemaIdentity: 'sha256:schema',
          storeDigest: 'sha256:store',
          affectedTargets: [{ platform: 'claude', scope: 'user' }],
        },
      }),
      executeIntent,
    });
    await value.buildOperationReview({
      kind: 'configSave', pluginId: 'official/enhance', scope: 'user',
      apply: true, retryApply: true,
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).not.toContain('Shared impact 需要显式确认');
    await input(instance, '\r');
    await nextTurn(3);
    expect(executeIntent).toHaveBeenCalledOnce();
  });

  it('executes an effective config no-op without shared confirmation', async () => {
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'succeeded', targetResults: [],
    });
    const value = controller({
      captureEvidence: vi.fn().mockResolvedValue({
        ...evidence,
        config: {
          scope: 'user', platform: 'codex', context: 'project',
          schemaIdentity: 'sha256:schema',
          storeDigest: 'sha256:store',
          impactState: 'known',
          noEffectiveChange: true,
          affectedTargets: [],
        },
      }),
      executeIntent,
    });
    await value.buildOperationReview({
      kind: 'configSave', pluginId: 'official/enhance', scope: 'user', context: 'project', platform: 'codex',
      apply: true, removeKeys: ['exploreWait'],
      changes: [{ key: 'exploreWait', title: '等待窗口', before: '15', after: '15' }],
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('有效设置输入不变');
    expect(instance.lastFrame()).not.toContain('请先确认会影响其他项目的内容');
    expect(instance.lastFrame()).not.toContain('动态 Skill');
    await input(instance, '\r');
    await nextTurn(3);
    expect(executeIntent).toHaveBeenCalledOnce();
  });

  it.each([[60, 18], [80, 24]] as const)('preserves both profile diffs before offering an update at %ix%i', async (columns, rows) => {
    const captureEvidence = vi.fn(async (intent: OperationIntent) => evidenceForIntent(intent));
    const value = controller({ getConfigPage: vi.fn(async (pluginId, options) => configPage(pluginId, options)), captureEvidence });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { profile: 'codex', context: 'project' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />); await nextTurn(5);
    await input(instance, '\r'); await focusAction(instance, '快速'); await input(instance, '\r');
    await chooseConfigProfile(instance, value, 'common');
    await input(instance, '\u001b[B', '\r'); await focusAction(instance, '关闭'); await input(instance, '\r');
    await openConfigSave(instance, value);
    expect(captureEvidence.mock.calls[0]![0]).toMatchObject({ kind: 'configSaveBatch', apply: false, context: 'project', groups: [
      { scope: 'user', changes: [expect.objectContaining({ key: 'enabled', before: '开启', after: '关闭' })] },
      { scope: 'user', platform: 'codex', changes: [expect.objectContaining({ key: 'level', before: 'strict', after: 'fast' })] },
    ] });
    expect(instance.lastFrame()).toContain('已保存，是否更新插件？');
    await writeAcceptanceTrace(`review-repair/config-${columns}x${rows}`,
      [acceptanceTraceStep(instance, { columns, rows }, '两个profile修改已保存', ['s'])]);
  });
});
