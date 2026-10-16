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
import type { ConfigPageViewModel } from '../../src/tui/model.js';

vi.mock('../../src/tui/clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import {
  configPage,
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
  chooseConfigTarget,
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

describe('ConsoleAppV4', () => {
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
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
      executeIntent: vi.fn().mockResolvedValue({
        status: 'partial',
        groups: [{
          scope: 'user', status: 'failed', configSaved: true,
          applyRequested: true, applyStatus: 'failed', errorCode: 'runtimeApplyFailed',
        }],
      }),
    });
    await partial.load();
    partial.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    partial.beginConfigFlow('team-tools/review-gate');
    partial.replace({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
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
    const reset = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })) });
    reset.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'project' } });
    const resetInstance = render(<ConsoleAppV4 controller={reset} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => resetScreens.add(screen)} />);
    await nextTurn(4);
    await focusAction(resetInstance, '设置选项');
    await input(resetInstance, '\r');
    await focusAction(resetInstance, '清空当前项目设置');
    await input(resetInstance, '\r');
    await nextTurn(3);
    expect(resetScreens).toContain('C22');
    expect(resetInstance.lastFrame()).toContain('当前项目');
    await input(resetInstance, 'd');
    let resetReviewFrames = resetInstance.lastFrame() ?? '';
    for (let page = 0; page < 12 && !resetReviewFrames.includes('个人默认保持不变'); page += 1) {
      await input(resetInstance, '\u001B[C');
      resetReviewFrames += `\n${resetInstance.lastFrame() ?? ''}`;
    }
    expect(resetReviewFrames).toContain('个人默认保持不变');

    const unavailableScreens = new Set<ConsoleV4ScreenId>();
    const unavailable = controller({
      getConfigPage: vi.fn().mockRejectedValue(new Error('catalogSourceUnavailable: private manifest error /Users/private')),
    });
    await unavailable.load();
    unavailable.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    unavailable.beginConfigFlow('team-tools/review-gate');
    unavailable.replace({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    const unavailableInstance = render(<ConsoleAppV4 controller={unavailable} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => unavailableScreens.add(screen)} />);
    await nextTurn(5);
    expect(unavailableScreens).toContain('C21');
    expect(unavailableInstance.lastFrame()).toContain('插件定义或来源不可用');
    expect(unavailableInstance.lastFrame()).toContain('修复插件来源');
    expect(unavailableInstance.lastFrame()).not.toContain('aw catalog source sync team-tools');
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
    const compact = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...longPage, layer })) });
    compact.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    const compactInstance = render(<ConsoleAppV4 controller={compact} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    await input(compactInstance, ...Array.from({ length: 8 }, () => '\u001B[B'));
    const compactFrame = compactInstance.lastFrame() ?? '';
    expect(compactFrame).toContain('› 字段 9');
    expect(compactFrame).not.toContain('字段 1\n');
    expect(compactFrame).not.toContain('保存并应用');
    await focusBottomAction(compactInstance, '设置选项');
    await input(compactInstance, '\r');
    await focusAction(compactInstance, '清空个人默认');
    expect(compactInstance.lastFrame()).toContain('› 清空个人默认');
    expect(compactFrame.split('\n').length).toBeLessThanOrEqual(18);

    const effective = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...longPage, layer })) });
    effective.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'effective', projectLayer: 'shared' } });
    const effectiveInstance = render(<ConsoleAppV4 controller={effective} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    await input(effectiveInstance, ...Array.from({ length: 8 }, () => '\u001B[B'));
    expect(effectiveInstance.lastFrame()).toContain('字段 9');
    expect(effectiveInstance.lastFrame()).toContain('› 字段 9');
    expect((effectiveInstance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
  });

  it('opens source-missing saved settings only for their recorded reset scope', async () => {
    const loaded = loadResult();
    loaded.configStoreInventory = [{
      pluginId: 'team-tools/retired-settings',
      sourceId: 'team-tools',
      pluginName: 'retired-settings',
      scope: 'project',
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
      storedScopes: ['project'],
      layer: { scope: 'project' },
      diagnosticCode: 'catalogSourceUnavailable',
      diagnosticStage: 'read-config',
    });
    expect(getConfigResetAvailability).toHaveBeenCalledWith(
      'team-tools/retired-settings',
      { scope: 'project' },
      expect.any(AbortSignal),
    );
    expect(instance.lastFrame()).toContain('重置当前项目设置层');
    expect(instance.lastFrame()).not.toContain('重置个人默认设置层');
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
      layer: { scope: 'user' },
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
    expect(instance.lastFrame()).toContain('重置个人默认设置层');
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

  it('keeps one reset action when the other invalid layer inspection fails', async () => {
    const value = controller({
      getConfigResetAvailability: vi.fn(async (_pluginId, layer: { scope: 'user' | 'project' }) => {
        if (layer.scope === 'user') throw new Error('unsafe user ancestor');
        return {
          exists: true,
          state: 'invalid' as const,
          sourceIdentityPresent: false,
          targetKind: 'directory' as const,
          resettable: true,
          storeDigest: 'sha256:project',
        };
      }),
    });
    value.push({
      name: 'configUnavailable',
      pluginId: 'team-tools/review-gate',
      invalidStores: [
        { scope: 'user', code: 'invalidJson', pathSummary: 'AW_HOME/plugin-config/team-tools/review-gate/config.json' },
        { scope: 'project', code: 'invalidValues', pathSummary: '<project>/.agent-workflows/plugin-config/team-tools/review-gate/config.json' },
      ],
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('重置当前项目设置层');
    expect(instance.lastFrame()).not.toContain('重置个人默认设置层');
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

    expect(instance.lastFrame()).toContain('个人默认设置层不能自动重置');
    expect(instance.lastFrame()).toContain('特殊节点，请手动移动');
    expect(instance.lastFrame()).not.toContain('重置个人默认设置层');
  });

  it.each([
    { invalidScope: 'user' as const, readyScope: 'project' as const },
    { invalidScope: 'project' as const, readyScope: 'user' as const },
  ])('binds an effective-entry invalid store to $invalidScope without offering $readyScope reset', async ({
    invalidScope,
    readyScope,
  }) => {
    const invalidStores = [{
      scope: invalidScope,
      code: 'invalidJson' as const,
      pathSummary: invalidScope === 'user'
        ? 'AW_HOME/plugin-config/team-tools/review-gate/config.json'
        : '<project>/.agent-workflows/plugin-config/team-tools/review-gate/config.json',
    }];
    const getConfigResetAvailability = vi.fn(async (_pluginId, layer: { scope: 'user' | 'project' }) => ({
      exists: true,
      state: layer.scope === invalidScope ? 'invalid' as const : 'ready' as const,
      ...(layer.scope === invalidScope ? { invalidCode: 'invalidJson' as const } : {}),
      sourceIdentityPresent: true,
      sourceIdentity: `identity:${layer.scope}`,
      storeDigest: `digest:${layer.scope}`,
    }));
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({
      getConfigPage: vi.fn().mockRejectedValue(new TuiConfigInvalidStoreError(invalidStores)),
      getConfigResetAvailability,
      captureEvidence,
    });
    value.push({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'effective' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(6);

    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configUnavailable',
      layer: { scope: invalidScope },
      invalidStores,
    });
    expect(instance.lastFrame()).toContain(
      `重置${invalidScope === 'user' ? '个人默认' : '当前项目'}设置层`,
    );
    expect(instance.lastFrame()).not.toContain(
      `重置${readyScope === 'user' ? '个人默认' : '当前项目'}设置层`,
    );
    expect(getConfigResetAvailability).toHaveBeenCalledTimes(1);
    expect(getConfigResetAvailability.mock.calls[0]?.[1]).toEqual({ scope: invalidScope });

    await input(instance, '\r');
    await nextTurn(4);
    expect(captureEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'configReset', scope: invalidScope }),
      expect.any(AbortSignal),
    );
  });

  it('lists two invalid stores in user-project order and can review either exact reset', async () => {
    const invalidStores = [
      {
        scope: 'user' as const,
        code: 'invalidJson' as const,
        pathSummary: 'AW_HOME/plugin-config/team-tools/review-gate/config.json',
      },
      {
        scope: 'project' as const,
        code: 'invalidValues' as const,
        pathSummary: '<project>/.agent-workflows/plugin-config/team-tools/review-gate/config.json',
      },
    ];
    const openReset = async (scope: 'user' | 'project') => {
      const captureEvidence = vi.fn().mockResolvedValue(evidence);
      const value = controller({
        getConfigPage: vi.fn().mockRejectedValue(new TuiConfigInvalidStoreError(invalidStores)),
        getConfigResetAvailability: vi.fn(async (_pluginId, layer: { scope: 'user' | 'project' }) => ({
          exists: true,
          state: 'invalid' as const,
          invalidCode: layer.scope === 'user' ? 'invalidJson' as const : 'invalidValues' as const,
          sourceIdentityPresent: true,
          sourceIdentity: `identity:${layer.scope}`,
          storeDigest: `digest:${layer.scope}`,
        })),
        captureEvidence,
      });
      value.push({
        name: 'configFields',
        pluginId: 'team-tools/review-gate',
        layer: { scope: 'effective' },
      });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
      await nextTurn(6);
      const frame = instance.lastFrame() ?? '';
      expect(frame.indexOf('重置个人默认设置层')).toBeLessThan(frame.indexOf('重置当前项目设置层'));
      if (scope === 'project') await input(instance, '\u001B[B');
      await input(instance, '\r');
      await nextTurn(4);
      expect(captureEvidence).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'configReset', scope }),
        expect.any(AbortSignal),
      );
      instance.unmount();
    };

    await openReset('user');
    await openReset('project');
  });

  it('does not let an aborted settings-layer response overwrite the effective page', async () => {
    let resolveUser!: (page: ConfigPageViewModel) => void;
    const userPage = new Promise<ConfigPageViewModel>((resolve) => {
      resolveUser = resolve;
    });
    const effectivePage = configPage();
    effectivePage.groups[0]!.fields[0]!.effectiveDisplayValue = '当前有效标记';
    const getConfigPage = vi.fn((_pluginId: string, layer: ConfigPageViewModel['layer']) =>
      layer.scope === 'user' ? userPage : Promise.resolve({ ...effectivePage, layer }));
    const value = controller({ getConfigPage });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'effective', projectLayer: 'shared' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('当前有效标记');

    const oldPage = configPage();
    oldPage.groups[0]!.fields[0]!.effectiveDisplayValue = '过期个人标记';
    resolveUser(oldPage);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('当前有效标记');
    expect(instance.lastFrame()).not.toContain('过期个人标记');
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
      layer: { scope: 'user' },
      fieldKey: 'model',
    }, { configGroupId: 'advanced', focusIndex: 2, scrollOffset: 1 });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configUnavailable',
      resumeRoute: {
        name: 'configFieldAction',
        pluginId: 'team-tools/review-gate',
        layer: { scope: 'user' },
        fieldKey: 'model',
      },
      resumeContext: { configGroupId: 'advanced', focusIndex: 2, scrollOffset: 1 },
    });
    expect(instance.lastFrame()).toContain('修复插件来源');
  });

  it('uses G04 when leaving a dirty config layer and can discard its draft', async () => {
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })) });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
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
    await focusAction(instance, '个人默认');
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
    const value = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })) });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
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
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    const recordId = value.recordUiFailure(undefined, { code: 'fixtureFailure', stage: 'fixture-stage' });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user' } });
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
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor', pluginId: page.pluginId, layer: { scope: 'user' },
      fieldKey: 'settings', editor: 'object', mode: 'choices',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\r');
    await nextTurn(3);
    await input(instance, '\u001B[B', '\r');
    await nextTurn(2);
    const draftRoute = value.snapshot.router.current.route;
    expect(value.externalDrafts).toEqual([
      expect.objectContaining({ kind: 'configDraft', owner: page.pluginId }),
    ]);

    value.push({ name: 'operationHistory' });
    await nextTurn(2);
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual(draftRoute);
    expect(value.hasSessionDraft).toBe(true);
    await input(instance, 'b');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    instance.unmount();
  });

  it('keeps a recovered source draft visible and blocks a field removed by the new schema', async () => {
    const initialPage = configPage();
    const refreshedPage = configPage();
    refreshedPage.groups[0]!.fields = refreshedPage.groups[0]!.fields
      .filter((field) => field.key !== 'level');
    let useRefreshedPage = false;
    const getConfigPage = vi.fn(async (pluginId: string, layer: ConfigPageViewModel['layer']) => ({
      ...(useRefreshedPage ? refreshedPage : initialPage), pluginId, layer,
    }));
    const value = controller({ getConfigPage });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    value.beginConfigFlow('team-tools/review-gate');
    value.replace({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
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
      layer: { scope: 'user' as const, projectLayer: 'shared' as const },
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

    expect(instance.lastFrame()).toContain('未保存修改已不适用于当前设置');
    expect(instance.lastFrame()).toContain('1 项待保存');
    expect(value.hasSessionDraft).toBe(true);
    await input(instance, 's');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).toContain('未保存修改已不适用于当前设置');
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
    const getConfigPage = vi.fn(async (pluginId: string, layer: ConfigPageViewModel['layer']) => ({
      ...(useRefreshedPage ? refreshedPage : initialPage), pluginId, layer,
    }));
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
      layer: { scope: 'user', projectLayer: 'shared' },
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
      layer: { scope: 'user' as const },
      fieldKey: 'level',
    };
    value.replace({
      name: 'configUnavailable',
      pluginId: 'team-tools/review-gate',
      overviewFrameId,
      layer: { scope: 'user' },
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
    expect(instance.lastFrame()).toContain('未保存修改已不适用于当前设置');
    expect(instance.lastFrame()).toContain('设置内容或可用位置已变化');
    expect(instance.lastFrame()).toContain('1 项待保存');
    await input(instance, 's');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).toContain('未保存修改已不适用于当前设置');
  });

  it('keeps one anchored config overview through source recovery and guards its original exit', async () => {
    const loaded = loadResult();
    loaded.catalogGenerations = loaded.catalogGenerations?.map((generation) =>
      generation.sourceId === 'team-tools'
        ? { ...generation, state: 'repairRequired' as const }
        : generation);
    const initialRead = deferred<ConfigPageViewModel>();
    let recovered = false;
    const getConfigPage = vi.fn((pluginId: string, layer: ConfigPageViewModel['layer']) => recovered
      ? Promise.resolve({ ...configPage(pluginId), layer })
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
    expect(value.snapshot.router.current.route.name).toBe('configLayer');
    await input(instance, '\u001B[B', '\r');
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
    'keeps a multi-field config summary and its complete final change reachable at %ix%i',
    async (columns, rows) => {
    const page = configPage();
    const fields = page.groups[0]!.fields;
    fields[2]!.title = '最后设置字段';
    fields[2]!.displayValue = '设置最后修改前唯一值';
    fields[2]!.value = '设置最后修改前唯一值';
    fields[2]!.draftValue = fields[2]!.value;
    fields[2]!.definition = { type: 'string' };
    fields[2]!.type = 'string';
    fields[2]!.fallbackDisplayValue = '设置最后修改后唯一值';
    fields[2]!.fallbackSourceLabel = '个人默认';
    const executeIntent = vi.fn();
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      const captured = evidenceForIntent(intent);
      if (intent.kind !== 'configSaveBatch') return captured;
      return {
        ...captured,
        configBatch: {
          groups: intent.groups.map((group) => ({
            scope: group.scope,
            targetFingerprint: `sha256:config-${group.scope}`,
            config: {
              scope: group.scope,
              storeDigest: 'sha256:config-store',
              impactState: 'known',
              affectedTargets: [
                { platform: 'codex', scope: 'user' },
                { platform: 'codex', scope: 'project' },
                { platform: 'claude', scope: 'user' },
                { platform: 'claude', scope: 'project' },
              ],
            },
          })),
        },
      };
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      captureEvidence,
      executeIntent,
    });
    value.push({
      name: 'configFields', pluginId: page.pluginId,
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    const trace: AcceptanceTraceStep[] = [];
    await nextTurn(4);

    await input(instance, 'u');
    await chooseConfigTarget(instance, value, 'user');
    await input(instance, '\u001B[B', '\u001B[B', 'u');
    await chooseConfigTarget(instance, value, 'user');
    await input(instance, '\u001B[A', 'u');
    await chooseConfigTarget(instance, value, 'user');
    expect(instance.lastFrame()).toContain('3 项待保存');
    await openConfigSave(instance, value);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('确认保存设置');
    expect(instance.lastFrame()).toContain('每层独立提交');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    await input(instance, '\u001B[A');
    trace.push(acceptanceTraceStep(instance, { columns, rows }, '设置汇总与影响计数', []));
    for (const label of [value.snapshot.activeReview!.primaryLabel, '改为只保存，稍后应用', '返回修改']) {
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
    expect(completeText).toContain('最后设置字段');
    expect(completeText).toContain('设置最后修改前唯一值');
    expect(completeText).toContain('设置最后修改后唯一值');
    expect(executeIntent).not.toHaveBeenCalled();
    trace.push(acceptanceTraceStep(instance, { columns, rows }, '完整设置变化尾部', ['Enter', 'ArrowRight']));
    await writeAcceptanceTrace(`config-save/multi-field-${columns}x${rows}`, trace);
    },
  );

  it('shows a committed config write with one failed target as partial', async () => {
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
      executeIntent: vi.fn().mockResolvedValue({
        status: 'partial',
        groups: [{
          scope: 'user', status: 'failed', configSaved: true,
          applyRequested: true, applyStatus: 'failed', errorCode: 'runtimeApplyFailed',
        }],
      }),
    });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'note',
      editor: 'string',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);
    await input(instance, 'DRAFT-KEEP', '\r');
    await chooseConfigTarget(instance, value, 'user');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'apply');
    await confirmReview(instance, value);
    await nextTurn(4);

    expect(value.snapshot.result).toMatchObject({ state: 'partial' });
    expect(value.snapshot.router.current.route.name).toBe('result');
    expect(instance.lastFrame()).toContain('已保存 1 个设置层；1 个设置层失败。');
    expect(instance.lastFrame()).toContain('所有项目');
    expect(instance.lastFrame()).toContain('已保存 · 应用失败');
    expect(instance.lastFrame()).toContain('返回修改');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    expect(screens).toContain('C13');
    await input(instance, '\r');
    await nextTurn(4);
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(instance.lastFrame()).toContain('重试应用插件设置');
  });

  it('shows a saved invalid config as unapplied instead of an apply failure', async () => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
      executeIntent: vi.fn().mockResolvedValue({
        status: 'partial',
        groups: [{
          scope: 'user', status: 'failed', configSaved: true,
          applyRequested: true, applyStatus: 'failed', errorCode: 'invalidConfig',
        }],
      }),
    });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'note',
      editor: 'string',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, 'SAVED', '\r');
    await chooseConfigTarget(instance, value, 'user');
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
      projectLayer: 'shared',
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
      projectLayer: 'shared',
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

    expect(instance.lastFrame()).toContain('重试应用插件设置');
    await input(instance, '\r');
    expect(executeIntent).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('返回检查');
    expect(instance.lastFrame()).toContain('确认重试应用插件设置');
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
          scope: 'project',
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
      kind: 'configSave', pluginId: 'official/enhance', scope: 'project',
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

  it.each([[60, 18], [80, 24]] as const)('review repair shows both before-after changes beside save choices at %ix%i', async (columns, rows) => {
    const page = configPage();
    const value = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })) });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(4);
    await input(instance, '\r');
    await focusAction(instance, '快速');
    await input(instance, '\r');
    await chooseConfigTarget(instance, value, 'project');
    await input(instance, '\u001B[B', '\r');
    await focusAction(instance, '关闭');
    await input(instance, '\r');
    await chooseConfigTarget(instance, value, 'user');
    await openConfigSave(instance, value);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('当前项目');
    expect(frame).toContain('level');
    expect(frame).toContain('strict → fast');
    expect(frame).toContain('个人默认');
    expect(frame).toContain('enabled');
    expect(frame).toContain('开启 → 关闭');
    expect(frame).toContain('保存并生效');
    expect(frame).toContain('只保存，稍后应用');
    await writeAcceptanceTrace(`review-repair/config-${columns}x${rows}`, [acceptanceTraceStep(instance, { columns, rows }, 'two short changes', [])]);
  });
});
