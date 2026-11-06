import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import type { ConfigSaveBatchExecutionResult, OperationIntent } from '../../src/tui/controller.js';
import type { ConfigPageViewModel, ConfigProfileKey, ConfigReadOptions } from '../../src/tui/model.js';
import { controller, deferred, evidenceForIntent } from '../helpers/tui-console-app-fixture.js';
import { input, nextTurn } from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

const pluginId = 'team-tools/review-gate';

function configPage(options: ConfigReadOptions, stored: ReadonlyMap<ConfigProfileKey, string>): ConfigPageViewModel {
  const profile = options.platform ?? 'common';
  const context = options.context ?? 'user';
  const value = stored.get(profile);
  return {
    pluginId, profile, context, layer: { profile, context },
    storedCount: value === undefined ? 0 : 1,
    presets: [],
    groups: [{
      id: 'main', title: '基本设置', advanced: false,
      fields: [{
        key: 'name', title: '服务名', type: 'string', definition: { type: 'string' },
        displayValue: value ?? '未设置', required: false, sensitive: false,
        writable: true, canSet: true, canUnset: value !== undefined,
        dirty: false, inherited: false, configured: value !== undefined,
        sourceLabel: value === undefined ? '未设置' : profile,
        effectiveDisplayValue: value ?? '未设置', effectiveSourceLabel: profile,
        allowCustom: true, advanced: false,
        ...(value === undefined ? {} : { value, draftValue: value, effectiveValue: value }),
      }],
    }],
  };
}

function savedResult(intent: Extract<OperationIntent, { kind: 'configSaveBatch' }>): ConfigSaveBatchExecutionResult {
  return {
    status: 'succeeded',
    groups: intent.groups.map((group) => ({
      scope: 'user', ...(group.platform ? { platform: group.platform } : {}),
      status: 'succeeded', configSaved: true, applyRequested: false, applyStatus: 'notRequested',
    })),
  };
}

async function editName(instance: ReturnType<typeof render>, text: string): Promise<void> {
  await input(instance, '\r');
  await nextTurn(3);
  await input(instance, text, '\r');
  await nextTurn(3);
}

describe('Console config platform drafts', () => {
  it('keeps same-name drafts in their selected profiles across Tab and saves them in the user store', async () => {
    const stored = new Map<ConfigProfileKey, string>();
    const executeIntent = vi.fn(async (intent: OperationIntent) => {
      if (intent.kind !== 'configSaveBatch') throw new Error('unexpected intent');
      for (const group of intent.groups) stored.set(group.platform ?? 'common', String(group.updates.name));
      return savedResult(intent);
    });
    const value = controller({
      getConfigPage: vi.fn(async (_pluginId, options) => configPage(options, stored)), executeIntent,
    });
    await value.load(); value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId, { context: 'project' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 30 }} />);
    await nextTurn(6);
    await editName(instance, 'common-draft');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFields', layer: { profile: 'common', context: 'project' } });
    await input(instance, '\t'); await nextTurn(5);
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFields', layer: { profile: 'codex', context: 'project' } });
    expect(instance.lastFrame()).not.toContain('common-draft');
    await editName(instance, 'codex-draft');
    await input(instance, '\u001b[Z'); await nextTurn(5);
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFields', layer: { profile: 'common' } });
    expect(instance.lastFrame()).toContain('common-draft');
    expect(instance.lastFrame()).not.toContain('codex-draft');
    await input(instance, 's'); await nextTurn(6);
    expect(executeIntent).toHaveBeenCalledOnce();
    expect(executeIntent.mock.calls[0]![0]).toMatchObject({
      kind: 'configSaveBatch', apply: false, context: 'project',
      groups: [
        { scope: 'user', updates: { name: 'common-draft' } },
        { scope: 'user', platform: 'codex', updates: { name: 'codex-draft' } },
      ],
    });
    expect(instance.lastFrame()).toContain('已保存，是否更新插件？');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    value.dispose();
  });

  it('waits for the save before offering an independent apply Review', async () => {
    const pending = deferred<ConfigSaveBatchExecutionResult>();
    const captureEvidence = vi.fn(async (intent: OperationIntent) => evidenceForIntent(intent));
    const executeIntent = vi.fn(async () => pending.promise);
    const value = controller({
      getConfigPage: vi.fn(async (_pluginId, options) => configPage(options, new Map())),
      executeIntent, captureEvidence,
    });
    await value.load(); value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId, { platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 30 }} />);
    await nextTurn(6); await editName(instance, 'saved-value');
    await input(instance, 's'); await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledOnce();
    expect(instance.lastFrame()).not.toContain('已保存，是否更新插件？');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    const save = captureEvidence.mock.calls[0]![0];
    expect(save.kind).toBe('configSaveBatch');
    pending.resolve(savedResult(save as Extract<OperationIntent, { kind: 'configSaveBatch' }>));
    await nextTurn(6);
    expect(instance.lastFrame()).toContain('已保存，是否更新插件？');
    await input(instance, '\r'); await nextTurn(5);
    expect(captureEvidence.mock.calls.at(-1)![0]).toMatchObject({
      kind: 'configSave', platform: 'codex', apply: true, retryApply: true, updates: {},
    });
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(executeIntent).toHaveBeenCalledOnce();
    value.dispose();
  });

  it('keeps only failed profile drafts after a partial save and does not offer the saved dialog', async () => {
    let first = true;
    const captureEvidence = vi.fn(async (intent: OperationIntent) => evidenceForIntent(intent));
    const executeIntent = vi.fn(async (intent: OperationIntent) => {
      if (intent.kind !== 'configSaveBatch') throw new Error('unexpected intent');
      if (!first) return savedResult(intent);
      first = false;
      return {
        status: 'partial',
        groups: savedResult(intent).groups.map((group) => group.platform === 'codex'
          ? { ...group, status: 'failed', configSaved: false, errorCode: 'writeFailed' } : group),
      };
    });
    const value = controller({
      getConfigPage: vi.fn(async (_pluginId, options) => configPage(options, new Map())), executeIntent, captureEvidence,
    });
    await value.load(); value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 30 }} />);
    await nextTurn(6); await editName(instance, 'common-value');
    await input(instance, '\t'); await nextTurn(5); await editName(instance, 'codex-value');
    await input(instance, 's'); await nextTurn(6);
    expect(instance.lastFrame()).not.toContain('已保存，是否更新插件？');
    expect(instance.lastFrame()).toContain('部分设置未保存');
    expect(instance.lastFrame()).toContain('codex-value');
    await input(instance, 's'); await nextTurn(6);
    expect(executeIntent.mock.calls[1]![0]).toMatchObject({
      kind: 'configSaveBatch', groups: [{ platform: 'codex', updates: { name: 'codex-value' } }],
    });
    expect((executeIntent.mock.calls[1]![0] as Extract<OperationIntent, { kind: 'configSaveBatch' }>).groups).toHaveLength(1);
    await input(instance, '\r'); await nextTurn(5);
    expect(captureEvidence.mock.calls.at(-1)![0]).toMatchObject({ kind: 'configSave', apply: true, retryApply: true });
    expect(captureEvidence.mock.calls.at(-1)![0]).not.toHaveProperty('platform');
    expect(captureEvidence.mock.calls.at(-1)![0]).not.toHaveProperty('targets');
    value.dispose();
  });
});
