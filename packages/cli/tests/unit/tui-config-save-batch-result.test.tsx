import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCommandPackageId } from '@lesliechan721/aw-plugin-core/manifest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import {
  TuiController,
  type OperationEvidence,
  type OperationIntent,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import type { ConfigPageViewModel, ConfigReadOptions } from '../../src/tui/model.js';
import { RecoveryInterruptedError } from '../../src/recovery/interruption.js';
import type { RecoveryReceipt } from '../../src/recovery/receipt.js';
import { ConfigApplyInterruptedError } from '../../src/utils/plugin-config-write.js';
import { skillInvocationWarning } from '../../src/utils/skill-invocation-warning.js';

import { chooseConfigProfile, chooseConfigSave, openConfigSave } from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

const pluginId = 'team/demo';

function status(): TuiStatusLoadResult {
  return {
    payload: {
      schemaVersion: 8,
      catalog: {
        primarySourceId: 'team', configDigest: 'sha256:config', compositeDigest: 'sha256:composite',
        sources: [{
          id: 'team', identity: 'identity:team', type: 'path', primary: true,
          requestedRef: 'path', freshness: 'active',
        }],
      },
      filters: { plugins: [], platform: 'both', cwd: '/workspace' },
      targets: [],
      errors: [],
    },
    pluginSummaries: [{
      pluginName: 'demo', pluginId, displayName: 'Demo', description: '设置批次测试', version: '1.0.0',
      supportedTargets: { codex: ['user', 'project'], claude: ['user', 'project'] },
      configFieldCount: 2,
    }],
    configuredSources: [{ id: 'team', type: 'path', primary: true, path: '/catalog', autoCheck: true }],
  };
}

function evidence(intent: OperationIntent): OperationEvidence {
  if (intent.kind === 'configSaveBatch') {
    return {
      catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
      configBatch: { groups: intent.groups.map((group) => ({
        scope: 'user', platform: group.platform,
        targetFingerprint: `sha256:${group.platform ?? 'common'}`,
        config: {
          scope: 'user', platform: group.platform, context: intent.context ?? 'user', storeDigest: `sha256:store:${group.platform ?? 'common'}`,
          impactState: 'known', affectedTargets: [{ platform: group.platform ?? 'codex', scope: intent.context ?? 'user' }],
        },
      })) },
    };
  }
  return {
    catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
    config: {
      scope: intent.kind === 'configSave' ? intent.scope : 'user',
      storeDigest: 'sha256:store:user', impactState: 'known',
      affectedTargets: [{ platform: 'codex', scope: intent.kind === 'configSave' ? intent.scope : 'user' }],
    },
  };
}

function configPage(options: ConfigReadOptions): ConfigPageViewModel {
  const profile = options.platform ?? 'common';
  const context = options.context ?? 'user';
  return {
    pluginId, profile, context, layer: { profile, context },
    storedCount: 0,
    presets: [],
    groups: [{
      id: 'main', title: '常用', advanced: false, fields: [{
        key: 'mode', title: '运行模式', type: 'string', definition: { type: 'string' },
        displayValue: '默认',
        required: false, sensitive: false, writable: true, canSet: true, canUnset: false,
        dirty: false, inherited: true, configured: false, sourceLabel: '插件默认',
        effectiveDisplayValue: '默认', effectiveSourceLabel: '插件默认', effectiveValue: 'default',
        draftValue: 'default',
        allowCustom: true, advanced: false,
      }],
    }],
  };
}

async function nextTurn(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function input(instance: ReturnType<typeof render>, ...values: string[]): Promise<void> {
  for (const value of values) {
    instance.stdin.write(value);
    await nextTurn(2);
  }
}

async function escape(instance: ReturnType<typeof render>): Promise<void> {
  instance.stdin.write('\u001b');
  await new Promise((resolve) => setTimeout(resolve, 80));
  await nextTurn(2);
}

describe('TUI config save batch result', () => {
  it('shows a shared package as retained after cleanup using the unchanged command result schema', async () => {
    const producer = { sourceId: 'team', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginName: 'demo',
      kind: 'package' as const, key: 'tools', platform: null, placementKey: null, scope: 'user' as const, projectRoot: null };
    const recovery = `aw command package remove ${getCommandPackageId(producer)} --yes`;
    const commandResult = { producer, state: 'partial', commandIds: ['installed-command'], removedCommandIds: [],
      errors: [{ code: 'commandResourceUnavailable', message: 'The retained package is unavailable.' }], recoveryActions: [recovery] };
    const value = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status()),
      captureEvidence: vi.fn(async () => ({ catalog: { configDigest: 'config', compositeDigest: 'composite' } })),
      executeIntent: vi.fn().mockResolvedValue({ platforms: ['codex'], plugins: [pluginId], warnings: [],
        recoveryActions: [recovery], targetResults: [], commandResults: [commandResult] }),
    });
    await value.load();
    const review = await value.buildOperationReview({ kind: 'pluginWrite', action: 'cleanup', pluginId, platform: 'codex', scope: 'user' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 28 }} />);
    await nextTurn(3);
    await value.executeOperation(review.reviewToken);
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('保留命令包 tools');
    expect(instance.lastFrame()).toContain('所有项目共用');
    expect(value.snapshot.result).toMatchObject({ state: 'partial', summary: { action: 'cleanup', commandResults: [commandResult], recoveryActions: [recovery] } });
  });
  it('keeps a retained command package visible in config Review and Result without a platform target', async () => {
    const producer = { sourceId: 'team', sourceIdentity: `sha256:${'a'.repeat(64)}`,
      pluginName: 'demo', kind: 'package' as const, key: 'tools', platform: null, placementKey: null,
      scope: 'user' as const, projectRoot: null };
    const commandResult = { producer, state: 'failed', commandIds: [], removedCommandIds: [],
      errors: [{ code: 'commandPackageApplyFailed', message: 'The command package could not be refreshed.' }],
      recoveryActions: ['aw command package sync team/demo tools --scope user --yes'] };
    const value = new TuiController({
      loadStatus: vi.fn().mockResolvedValue(status()),
      captureEvidence: vi.fn(async () => ({
        catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
        config: { scope: 'user', storeDigest: 'sha256:store', impactState: 'known', affectedTargets: [],
          commandPackages: [{ producer, packageId: `pkg_${'1'.repeat(64)}`, packageKey: 'tools', refreshKeys: ['mode'], declared: true, installed: true }] },
      })),
      executeIntent: vi.fn().mockResolvedValue({ configWrite: 'succeeded', overallState: 'partial',
        apply: { state: 'partial', targetResults: [], commandResults: [commandResult] } }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'configSave', pluginId, scope: 'user', apply: true,
      updates: { mode: 'fast' }, changes: [{ key: 'mode', title: '模式', before: 'safe', after: 'fast' }],
    });
    expect(review.configImpact?.affectedTargetCount).toBe(1);
    expect(review.changes).toContainEqual(expect.objectContaining({ title: '刷新命令包 tools' }));
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    await value.executeOperation(review.reviewToken);
    await nextTurn(3);
    expect(value.snapshot.result).toMatchObject({ state: 'partial', summary: {
      commandResults: [commandResult], configApplyRetryAvailable: true,
    } });
    expect(instance.lastFrame()).toContain('命令包 tools');
    expect(instance.lastFrame()).toContain('失败');
    expect(value.snapshot.result && 'summary' in value.snapshot.result
      ? value.snapshot.result.summary?.targets : undefined).toBeUndefined();
  });
  it('opens the usable settings overview from a portable missing-config blocker', async () => {
    const dependencies: TuiControllerDependencies = {
      loadStatus: vi.fn().mockResolvedValue(status()),
      captureEvidence: vi.fn(async (intent: OperationIntent) => evidence(intent)),
      executeIntent: vi.fn(),
      getConfigPage: vi.fn(async (_pluginId, layer) => configPage(layer)),
    };
    const value = new TuiController(dependencies);
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    value.push({ name: 'portableBlocker', pluginId, code: 'requiredConfigMissing' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'configFields', pluginId, layer: { profile: 'common' },
    });
    expect(instance.lastFrame()).toContain('插件设置');
    expect(instance.lastFrame()).not.toContain('正在检查可用保存位置');
  });

  it('keeps an editor-cancelled value private and discards only that candidate', async () => {
    const captured: OperationIntent[] = [];
    const value = new TuiController({
      loadStatus: vi.fn().mockResolvedValue(status()),
      captureEvidence: vi.fn(async (intent) => { captured.push(intent); return evidence(intent); }),
      executeIntent: vi.fn(),
      getConfigPage: vi.fn(async (_pluginId, options) => configPage(options)),
    });
    await value.load(); value.push({ name: 'pluginDetail', pluginId }); value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);
    await input(instance, '\r', '\u0015', 'candidate-only');
    expect(JSON.stringify(value.snapshot)).not.toContain('candidate-only');
    await escape(instance);
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).not.toContain('candidate-only');
    expect(instance.lastFrame()).not.toContain('项待保存');
    expect(captured).toEqual([]);
  });

  it('keeps same-name drafts in two portable profiles and stores both in the user document', async () => {
    const captured: OperationIntent[] = [];
    const value = new TuiController({
      loadStatus: vi.fn().mockResolvedValue(status()),
      captureEvidence: vi.fn(async (intent) => { captured.push(intent); return evidence(intent); }),
      executeIntent: vi.fn(async (intent) => {
        if (intent.kind !== 'configSaveBatch') throw new Error('unexpected intent');
        return { status: 'succeeded', groups: intent.groups.map((group) => ({
          scope: 'user', platform: group.platform, status: 'succeeded', configSaved: true,
          applyRequested: false, applyStatus: 'notRequested',
        })) };
      }),
      getConfigPage: vi.fn(async (_pluginId, options) => configPage(options)),
    });
    await value.load(); value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId, { platform: 'cursor', context: 'project' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);
    await input(instance, '\r', '\u0015', 'cursor-value', '\r');
    await chooseConfigProfile(instance, value, 'generic');
    await input(instance, '\r', '\u0015', 'generic-value', '\r');
    expect(instance.lastFrame()).not.toContain('cursor-value');
    await openConfigSave(instance, value);
    expect(captured[0]).toMatchObject({ kind: 'configSaveBatch', apply: false, context: 'project', groups: [
      { scope: 'user', platform: 'cursor', updates: { mode: 'cursor-value' } },
      { scope: 'user', platform: 'generic', updates: { mode: 'generic-value' } },
    ] });
    await chooseConfigSave(instance, value, 'apply');
    expect(captured.at(-1)).toMatchObject({ kind: 'configSave', apply: true, retryApply: true, targets: ['cursor', 'generic'], updates: {} });
  });

  it('keeps the failed Claude draft after applying an already saved Codex profile', async () => {
    const captured: OperationIntent[] = [];
    const value = new TuiController({
      loadStatus: vi.fn().mockResolvedValue(status()),
      captureEvidence: vi.fn(async (intent) => { captured.push(intent); return evidence(intent); }),
      executeIntent: vi.fn(async (intent) => intent.kind === 'configSaveBatch' ? {
        status: 'partial', groups: [
          { scope: 'user', platform: 'codex', status: 'succeeded', configSaved: true, applyRequested: false, applyStatus: 'notRequested' },
          { scope: 'user', platform: 'claude', status: 'failed', configSaved: false, applyRequested: false, applyStatus: 'notRequested', errorCode: 'configWriteFailed' },
        ],
      } : { configWrite: 'notStarted', overallState: 'succeeded', apply: { state: 'succeeded', targetResults: [] } }),
      getConfigPage: vi.fn(async (_pluginId, options) => configPage(options)),
    });
    await value.load(); value.push({ name: 'pluginDetail', pluginId }); value.beginConfigFlow(pluginId, { platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);
    await input(instance, '\r', '\u0015', 'codex-value', '\r');
    await chooseConfigProfile(instance, value, 'claude');
    await input(instance, '\r', '\u0015', 'claude-value', '\r', 's');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('部分设置未保存'));
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('claude-value'));
    const review = await value.buildOperationReview({ kind: 'configSave', pluginId, platform: 'codex', apply: true, retryApply: true, updates: {} });
    await value.executeOperation(review.reviewToken); await nextTurn(5);
    expect(captured.at(-1)).toMatchObject({ kind: 'configSave', platform: 'codex', retryApply: true, updates: {} });
    expect(instance.lastFrame()).toContain('已应用已保存的设置');
    expect(value.externalDrafts).toEqual([expect.objectContaining({ kind: 'configDraft', owner: pluginId })]);
  });

  it('shows each profile result and retries only the saved profile whose apply failed', async () => {
    const captured: OperationIntent[] = [];
    const value = new TuiController({
      loadStatus: vi.fn().mockResolvedValue(status()),
      captureEvidence: vi.fn(async (intent) => { captured.push(intent); return evidence(intent); }),
      executeIntent: vi.fn(async () => ({ status: 'partial', groups: [
        { scope: 'user', platform: 'codex', status: 'failed', configSaved: false, applyRequested: true, applyStatus: 'notRequested', errorCode: 'configWriteFailed' },
        { scope: 'user', platform: 'claude', status: 'failed', configSaved: true, applyRequested: true, applyStatus: 'failed', errorCode: 'configApplyFailed' },
      ] })),
    });
    await value.load();
    const review = await value.buildOperationReview({ kind: 'configSaveBatch', pluginId, apply: true, groups: [
      { scope: 'user', platform: 'codex', updates: { mode: 'codex-value' } },
      { scope: 'user', platform: 'claude', updates: { mode: 'claude-value' } },
    ] });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await value.executeOperation(review.reviewToken); await nextTurn(5);
    expect(instance.lastFrame()).toContain('Codex');
    expect(instance.lastFrame()).toContain('Claude');
    expect(instance.lastFrame()).toContain('保存失败');
    expect(instance.lastFrame()).toContain('已保存 · 应用失败');
    await input(instance, '\r'); await nextTurn(5);
    expect(captured.at(-1)).toMatchObject({ kind: 'configSave', scope: 'user', platform: 'claude', retryApply: true, updates: {}, removeKeys: [] });
  });

  it.each(['saved with unconfirmed cleanup', 'retry interrupted', 'retry interrupted before any delivery'] as const)(
    'preserves the confirmed config apply facts after %s',
    async (mode) => {
      const retryApply = mode !== 'saved with unconfirmed cleanup';
      const delivered = mode !== 'retry interrupted before any delivery';
      const code = retryApply ? 'operationInterrupted' : 'processCleanupUnconfirmed';
      const notice = skillInvocationWarning('git-commit', [
        { feature: 'skill.invocation.model', values: ['false'] },
      ], { pluginId, target: 'generic', scope: 'user' })!;
      const cause = retryApply ? new DOMException('Cancelled', 'AbortError')
        : Object.assign(new Error('Cleanup unconfirmed'), { code });
      // The controller receives the config receipt already projected by the domain service.
      const interrupted = new ConfigApplyInterruptedError(new RecoveryInterruptedError({} as RecoveryReceipt, cause), {
        state: 'partial',
        ...(delivered ? { diagnostics: [notice] } : {}),
        targetResults: [
          ...(delivered ? [{ target: { pluginName: 'demo', pluginId, platform: 'generic' as const, scope: 'user' as const },
            state: 'completed' as const, action: 'refresh' }] : []),
          { target: { pluginName: 'demo', pluginId, platform: 'codex', scope: 'user' }, state: 'failed', action: 'refresh', errorCode: code },
        ],
      });
      if (!retryApply) interrupted.configWrite = 'succeeded';
      const captured: OperationIntent[] = [];
      const value = new TuiController({
        loadStatus: vi.fn().mockResolvedValue(status()),
        captureEvidence: vi.fn(async (intent) => { captured.push(intent); return evidence(intent); }),
        executeIntent: vi.fn().mockRejectedValue(interrupted),
      });
      await value.load();
      const review = await value.buildOperationReview({
        kind: 'configSave', pluginId, scope: 'user', apply: true,
        ...(retryApply ? { retryApply: true } : { updates: { mode: 'new' } }),
      });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 35 }} />);
      await value.executeOperation(review.reviewToken);
      if (!delivered) {
        expect(value.snapshot.result).toMatchObject({ state: 'blocked', code: 'operationInterrupted' });
        return;
      }
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('部分插件目标已更新'));
      expect(value.snapshot.result).toMatchObject({
        state: 'partial', effects: { configCommit: retryApply ? 'notStarted' : 'completed', awWrite: 'partial' },
        summary: {
          configTargets: [
            { pluginId, platform: 'generic', scope: 'user', state: 'completed' },
            { pluginId, platform: 'codex', scope: 'user', state: 'failed', errorCode: code },
          ],
          configDiagnostics: [notice],
        },
      });
      expect(instance.lastFrame()).toContain('git-commit');
      if (retryApply) {
        expect(instance.lastFrame()).not.toContain('设置已保存');
        expect(instance.lastFrame()).toContain('应用已中断');
      } else {
        expect(instance.lastFrame()).toContain('设置已保存');
        expect(instance.lastFrame()).toContain('无法确认进程已清理');
      }
      await input(instance, '\r');
      await vi.waitFor(() => expect(captured.at(-1)).toMatchObject({
        kind: 'configSave', retryApply: true, updates: {}, targets: ['codex'],
      }));
    },
  );

  it('pages config apply notices and retains exact controls in compact technical details', async () => {
    const location = { pluginId, target: 'generic', scope: 'project' } as const;
    const warnings = Array.from({ length: 8 }, (_, index) => skillInvocationWarning(`skill-${index}`, [
      { feature: 'skill.invocation.model', values: ['false'] },
    ], location)!);
    const value = new TuiController({
      loadStatus: vi.fn().mockResolvedValue(status()),
      captureEvidence: vi.fn(async (intent) => evidence(intent)),
      executeIntent: vi.fn(async () => ({ status: 'succeeded', groups: [
        { scope: 'user', status: 'succeeded', configSaved: true, applyRequested: true, applyStatus: 'succeeded', execution: {
          configWrite: 'succeeded', overallState: 'succeeded',
          apply: { state: 'succeeded', targetResults: [], diagnostics: [...warnings, warnings[0]!] },
        } },
      ] })),
    });
    await value.load();
    const review = await value.buildOperationReview({ kind: 'configSaveBatch', pluginId, apply: true, groups: [
      { scope: 'user', updates: { mode: 'updated' } },
    ] });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await value.executeOperation(review.reviewToken);
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('设置已保存并应用'));
    expect(instance.lastFrame()).toContain('当前项目 · skill-0 已安装');
    expect(instance.lastFrame()).not.toContain('重试应用');

    const collectPages = async (): Promise<string> => {
      const frames = [instance.lastFrame()!];
      for (let i = 0; i < 30; i += 1) {
        await input(instance, '\u001b[C');
        const frame = instance.lastFrame()!;
        if (frames.at(-1) === frame) break;
        frames.push(frame);
      }
      return frames.join('\n');
    };
    const summary = await collectPages();
    expect(summary).toContain('禁止模型自动调用');
    expect(summary).toContain('skill-7 已安装');
    expect(summary.match(/skill-0 已安装/gu)).toHaveLength(1);
    await input(instance, 'd');
    const details = await collectPages();
    expect(details).toContain('skill.invocation.model=false');
    expect(details).toContain('noBoundExecutor');
    expect(details).toContain('skill-7 已安装');
    value.dispose();
  });
});
