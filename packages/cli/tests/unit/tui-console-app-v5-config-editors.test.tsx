import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConsoleAppV4,
  type ConsoleV4ScreenId,
} from '../../src/tui/console-app-v4.js';
import {
  type OperationIntent,
} from '../../src/tui/controller.js';
import type { ConfigPageViewModel } from '../../src/tui/model.js';
import { copyToClipboard } from '../../src/tui/clipboard.js';

vi.mock('../../src/tui/clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import {
  configPage,
  controller,
  evidence,
  evidenceForIntent,
  objectConfigPage,
} from '../helpers/tui-console-app-fixture.js';

import {
  chooseConfigSave,
  chooseConfigTarget,
  confirmReview,
  focusAction,
  input,
  nextTurn,
  openConfigSave,
} from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

function configuredObjectPage(pluginId = 'team-tools/review-gate'): ConfigPageViewModel {
  const page = objectConfigPage(pluginId);
  const field = page.groups[0]!.fields[0]!;
  const current = {
    owner: 'Alice',
    region: 'west',
    token: 'CURRENT-SECRET',
  };
  page.storedCount = 1;
  field.configured = true;
  field.inherited = false;
  field.displayValue = '已设置 · 3 项';
  field.value = current;
  field.draftValue = current;
  field.fallbackDisplayValue = '已设置 · 3 项';
  field.fallbackSourceLabel = '当前项目';
  field.fallbackObjectChanges = [
    { property: 'owner', before: 'Alice', after: 'Service' },
    { property: 'token', before: '已设置', after: '已设置', private: true },
  ];
  return page;
}

describe('ConsoleAppV4', () => {
  it('uses visible group tabs and edits a focused effective field before selecting its save target', async () => {
    const reached = new Set<ConsoleV4ScreenId>();
    const getConfigPage = vi.fn(async (
      pluginId: string,
      layer: ConfigPageViewModel['layer'],
    ) => {
      const page = configPage(pluginId);
      return {
        ...page,
        layer,
        groups: layer.scope === 'effective'
          ? page.groups.map((group) => ({
              ...group,
              fields: group.fields.map((field) => ({
                ...field,
                displayValue: field.effectiveDisplayValue,
                sourceLabel: field.effectiveSourceLabel,
                ...(field.effectiveValue !== undefined ? { value: field.effectiveValue } : {}),
              })),
            }))
          : page.groups,
      };
    });
    const value = controller({ getConfigPage });
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => reached.add(screen)}
    />);
    await nextTurn(4);

    await focusAction(instance, '插件设置');
    await input(instance, '\r');
    await nextTurn(3);
    expect(reached).toContain('C01');
    const effectiveFrame = instance.lastFrame() ?? '';
    expect(effectiveFrame).toContain('插件设置');
    expect(effectiveFrame).toContain('基本设置');
    expect(effectiveFrame).toContain('个人默认');
    expect(effectiveFrame).toContain('未设置');
    expect(effectiveFrame).not.toContain('保存修改');
    expect(effectiveFrame).toContain('快速方案 1');
    expect(effectiveFrame).toContain('› level');
    expect(effectiveFrame).not.toContain('/Users/private');

    const depth = value.snapshot.router.depth;
    await input(instance, '\u001B[C');
    expect(value.snapshot.router.depth).toBe(depth);
    expect(value.snapshot.router.current.context.configGroupId).toBe('advanced');
    expect(instance.lastFrame()).toContain('› model');
    expect(instance.lastFrame()).not.toContain('› level');
    await input(instance, '\u001B[D');
    expect(value.snapshot.router.depth).toBe(depth);
    expect(instance.lastFrame()).toContain('› level');

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', fieldKey: 'level', layer: { scope: 'effective' },
    });
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', fieldKey: 'level', layer: { scope: 'effective' },
    });
    await input(instance, '\u001B[B', '\r');
    await nextTurn(3);
    expect(reached).toContain('C07');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configLayer', fieldKey: 'level',
    });
    const chooserFrame = instance.lastFrame() ?? '';
    expect(chooserFrame).toContain('“level”保存到哪里？');
    expect(chooserFrame).toContain('新值：balanced');
    expect(chooserFrame).toContain('个人默认');
    expect(chooserFrame).toContain('当前项目');
    const layerRoute = value.snapshot.router.current.route;
    await input(instance, '\t');
    expect(value.snapshot.router.current.route).toEqual(layerRoute);

    await input(instance, '\u001B[B', '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', layer: { scope: 'effective' },
    });
    expect(value.snapshot.router.current.context).toMatchObject({ configGroupId: 'basic', focusIndex: 0 });
    expect(instance.lastFrame()).toContain('› level');
    expect(instance.lastFrame()).toContain('待保存到个人默认');
  });

  it('opens the preview settings action on the effective read-only homepage', async () => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    value.push({ name: 'pluginDetail', pluginId: 'official/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await focusAction(instance, '插件设置');
    await input(instance, '\r');
    await nextTurn(3);

    expect(value.snapshot.router.current.route).toEqual({
      name: 'configFields',
      pluginId: 'official/review-gate',
      layer: { scope: 'effective' },
    });
    expect(instance.lastFrame()).toContain('插件设置');
    expect(instance.lastFrame()).not.toContain('保存修改');
  });

  it('uses preset-first scalar choices and retains invalid Core-validated input', async () => {
    const page = configPage();
    const getConfigPage = vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer }));
    const closed = controller({ getConfigPage });
    closed.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    closed.push({
      name: 'configFieldEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'level',
      editor: 'string',
      mode: 'choices',
    });
    const closedInstance = render(<ConsoleAppV4 controller={closed} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    expect(closedInstance.lastFrame()).toContain('快速');
    expect(closedInstance.lastFrame()).toContain('平衡（推荐）');
    expect(closedInstance.lastFrame()).not.toContain('自定义');

    closedInstance.unmount();
    const invalidPage = configPage();
    const note = invalidPage.groups[0]!.fields.find((field) => field.key === 'note')!;
    note.definition = { type: 'string', validation: { pattern: '^[A-Z]+$', maxLength: 20 } };
    const invalid = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...invalidPage, pluginId, layer })),
    });
    invalid.push({ name: 'configFields', pluginId: invalidPage.pluginId, layer: { scope: 'user' } });
    invalid.push({
      name: 'configFieldEditor',
      pluginId: invalidPage.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'note',
      editor: 'string',
      mode: 'custom',
    });
    const invalidInstance = render(<ConsoleAppV4 controller={invalid} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(invalidInstance, 'bad', '\r');
    expect(invalid.snapshot.router.current.route.name).toBe('configFieldEditor');
    expect(invalidInstance.lastFrame()).not.toContain('pattern');
    expect(invalidInstance.lastFrame()).toContain('Expected a value that matches');
    expect(invalidInstance.lastFrame()).toContain('bad');
  });

  it('keeps top-level boolean presets closed or open and saves the actual value', async () => {
    const page = configPage();
    const field = page.groups[0]!.fields.find((candidate) => candidate.key === 'enabled')!;
    field.definition = {
      type: 'boolean',
      choices: {
        allowCustom: false,
        presets: [{ id: 'on', title: '仅开启', value: true, recommended: true }],
      },
    };
    field.choices = [{ id: 'on', title: '仅开启', value: true, recommended: true }];
    field.allowCustom = false;
    field.configured = false;
    field.inherited = true;
    delete field.value;
    delete field.draftValue;
    const executeIntent = vi.fn().mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      executeIntent,
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'enabled',
      editor: 'boolean',
      mode: 'choices',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('仅开启（推荐）');
    expect(instance.lastFrame()).not.toContain('○ 关闭');
    await input(instance, '\r');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'configSaveBatch',
      groups: [expect.objectContaining({ scope: 'user', updates: { enabled: true } })],
    }), expect.objectContaining(evidence));

    instance.unmount();
    const openPage = configPage();
    const openField = openPage.groups[0]!.fields.find((candidate) => candidate.key === 'enabled')!;
    openField.definition = {
      type: 'boolean',
      choices: {
        allowCustom: true,
        presets: [{ id: 'on', title: '开启方案', value: true }],
      },
    };
    openField.choices = [{ id: 'on', title: '开启方案', value: true }];
    openField.allowCustom = true;
    const open = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...openPage, pluginId, layer })),
    });
    open.push({ name: 'configFields', pluginId: openPage.pluginId, layer: { scope: 'user' } });
    open.push({
      name: 'configFieldEditor',
      pluginId: openPage.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'enabled',
      editor: 'boolean',
      mode: 'choices',
    });
    const openInstance = render(<ConsoleAppV4 controller={open} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    const openFrame = openInstance.lastFrame() ?? '';
    expect(openFrame).toContain('开启方案');
    expect(openFrame).toContain('关闭');
    expect(openFrame.match(/开启方案/gu)).toHaveLength(1);
    expect(openFrame).not.toContain('自定义');
  });

  it('edits a mixed fixed and dynamic object from the effective seed and reviews one full top-level update', async () => {
    const clipboard = vi.mocked(copyToClipboard).mockReset().mockResolvedValue(undefined);
    const page = objectConfigPage();
    const executeIntent = vi.fn().mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      executeIntent,
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      editor: 'object',
      mode: 'choices',
    });
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
    expect(instance.lastFrame()).toContain('服务方案（推荐）');
    expect(instance.lastFrame()).toContain('自定义');

    await input(instance, '\u001B[B', '\r');
    const seededFrame = instance.lastFrame() ?? '';
    expect(seededFrame).toContain('草稿来自当前完整有效对象');
    expect(seededFrame).toContain('legacy');
    expect(seededFrame).toContain('令牌');
    expect(seededFrame).not.toContain('SECRET-BYTES');

    await input(instance, '\r', '\r', 'hHqb');
    expect(instance.lastFrame()).toContain('AlicehHqb');
    expect(onSessionNavigation).not.toHaveBeenCalled();
    await input(instance, ...Array.from({ length: 9 }, () => '\u007F'), 'bad-name', '\r');
    expect(instance.lastFrame()).toContain('format');
    expect(instance.lastFrame()).toContain('bad-name');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configObjectPropertyEditor', propertyKey: 'owner', stage: 'custom',
    });
    await input(instance, ...Array.from({ length: 8 }, () => '\u007F'), 'Bob', '\r');

    await input(instance, 'h');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    expect(instance.lastFrame()).toContain('继续编辑');
    await input(instance, '\r');
    expect(value.hasSessionDraft).toBe(true);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', fieldKey: 'settings', editor: 'object',
    });

    await input(instance, ...Array.from({ length: 3 }, () => '\u001B[B'), '\r', '\u001B[B', '\r');
    expect(instance.lastFrame()).not.toContain('legacy');
    await input(instance, '\r', 'new_key', '\r', 'ready', '\r');
    expect(instance.lastFrame()).toContain('new_key');
    expect(instance.lastFrame()).not.toContain('SECRET-BYTES');

    await input(instance, ...Array.from({ length: 2 }, () => '\u001B[B'), '\r');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');
    expect(value.snapshot.activeReview?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '个人默认 · 服务设置',
        description: expect.stringContaining('owner: Alice → Bob'),
      }),
    ]));
    expect(instance.lastFrame()).toContain('确认保存设置');
    expect(instance.lastFrame()).toContain('3 个子');
    expect(instance.lastFrame()).toContain('owner · Alice → Bob');
    expect(instance.lastFrame()).toContain('legacy · old → 未设置');
    expect(instance.lastFrame()).toContain('new_key · 未设置 → ready');
    expect(instance.lastFrame()).not.toContain('SECRET-BYTES');
    await input(instance, 'y');
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledTimes(1));
    const copied = clipboard.mock.calls[0]![0];
    expect(copied).toContain('owner · Alice → Bob');
    expect(copied).toContain('legacy · old → 未设置');
    expect(copied).toContain('new_key · 未设置 → ready');
    expect(copied).not.toContain('SECRET-BYTES');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(24);
    instance.rerender(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }}
      onSessionNavigation={onSessionNavigation} />);
    await nextTurn(3);
    const compactPages: string[] = [];
    for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      const frame = instance.lastFrame() ?? '';
      expect(frame.split('\n').length).toBeLessThanOrEqual(18);
      expect(Math.max(...frame.split('\n').map(stringWidth))).toBeLessThanOrEqual(60);
      compactPages.push(frame);
      if (pageIndex > 0 && frame === compactPages.at(-2)) break;
      await input(instance, '\u001b[6~');
    }
    const compactDocument = compactPages.join('\n');
    for (const change of ['owner · Alice → Bob', 'legacy · old → 未设置', 'new_key · 未设置 → ready']) {
      expect(compactDocument).toContain(change);
    }
    expect(compactDocument).not.toContain('SECRET-BYTES');
    await input(instance, 'y');
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledTimes(2));
    expect(clipboard.mock.calls[1]![0]).toBe(copied);
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'configSaveBatch',
      groups: [expect.objectContaining({
        scope: 'user',
        updates: {
          settings: {
            owner: 'Bob',
            region: 'west',
            token: 'SECRET-BYTES',
            new_key: 'ready',
          },
        },
      })],
    }), expect.objectContaining(evidence));
  });

  it.each([
    { columns: 80, rows: 24 },
    { columns: 60, rows: 18 },
  ])('keeps one object focus and its add/save actions visible at $columns x $rows', async (size) => {
    const page = objectConfigPage();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      editor: 'object',
      mode: 'custom',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(4);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('添加键值');
    expect(frame).toContain('使用此完整对象');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
  });

  it('stores the actual complete object value selected by an object preset', async () => {
    const page = objectConfigPage();
    const executeIntent = vi.fn().mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      executeIntent,
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      editor: 'object',
      mode: 'choices',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    expect(instance.lastFrame()).not.toContain('preset-secret');
    await input(instance, '\r');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');
    expect(value.snapshot.activeReview?.changes[0]?.description).toContain('3 个子项变化');
    expect(value.snapshot.activeReview?.changes[0]?.description).toContain('owner: Alice → Service');
    expect(instance.lastFrame()).toContain('已设置');
    expect(instance.lastFrame()).not.toContain('方案“服务方案”');
    expect(instance.lastFrame()).not.toContain('preset-secret');
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'configSaveBatch',
      groups: [expect.objectContaining({
        scope: 'user',
        updates: {
          settings: { owner: 'Service', region: 'west', token: 'preset-secret' },
        },
      })],
    }), expect.objectContaining(evidence));
  });

  it('does not show which object preset matches a sensitive child and still applies a selected preset', async () => {
    const page = objectConfigPage();
    const field = page.groups[0]!.fields[0]!;
    const first = field.choices![0]!;
    const second = {
      ...first,
      id: 'service-b',
      title: '备用服务方案',
      value: { owner: 'Service', region: 'west', token: 'other-preset-secret' },
    };
    field.choices = [first, second];
    if (field.definition.type !== 'object' || !field.definition.choices) {
      throw new Error('expected object choices fixture');
    }
    field.definition.choices.presets = [first, second];
    field.draftValue = first.value;
    field.effectiveValue = first.value;
    field.effectiveDisplayValue = '已设置 · 3 项';
    const executeIntent = vi.fn().mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      executeIntent,
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      editor: 'object',
      mode: 'choices',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    const editorFrame = instance.lastFrame() ?? '';
    expect(editorFrame).toContain('○ 服务方案');
    expect(editorFrame).toContain('○ 备用服务方案');
    expect(editorFrame).not.toContain('● 服务方案');
    expect(editorFrame).not.toContain('preset-secret');

    await input(instance, '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('新值：已设置');
    expect(instance.lastFrame()).not.toContain('other-preset-secret');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');
    expect(value.snapshot.activeReview?.changes[0]?.description).toContain('token: 已设置 → 将更新');
    expect(value.snapshot.activeReview?.changes[0]?.description).not.toContain('服务方案');
    expect(JSON.stringify(value.snapshot.activeReview)).not.toContain('preset-secret');
    expect(instance.lastFrame()).not.toContain('preset-secret');
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'configSaveBatch',
      groups: [expect.objectContaining({ scope: 'user', updates: { settings: second.value } })],
    }), expect.objectContaining(evidence));
  });

  it('does not show which object preset matches sensitive additional properties', async () => {
    const page = objectConfigPage();
    const field = page.groups[0]!.fields[0]!;
    if (field.definition.type !== 'object') throw new Error('expected object fixture');
    const presets = [
      { id: 'primary', title: '主账户', value: { account: 'secret-a' } },
      { id: 'secondary', title: '备用账户', value: { account: 'secret-b' } },
    ];
    field.definition.properties = {};
    field.definition.additionalProperties = { type: 'string', sensitive: true };
    field.definition.choices = { allowCustom: true, presets };
    field.choices = presets;
    field.draftValue = presets[0]!.value;
    field.effectiveValue = presets[0]!.value;
    field.effectiveDisplayValue = '已设置 · 1 项';
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('已设置 · 1 项');
    expect(instance.lastFrame()).not.toContain('主账户');
    value.push({
      name: 'configFieldEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      editor: 'object',
      mode: 'choices',
    });
    await nextTurn(2);
    const editorFrame = instance.lastFrame() ?? '';
    expect(editorFrame).toContain('○ 主账户');
    expect(editorFrame).toContain('○ 备用账户');
    expect(editorFrame).not.toContain('● 主账户');
    expect(editorFrame).not.toContain('secret-a');
  });

  it('uses a closed child choice without a custom route', async () => {
    const page = objectConfigPage();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configObjectPropertyEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      propertyKey: 'region',
      dynamic: false,
      stage: 'choices',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('西区');
    expect(frame).toContain('东区');
    expect(frame).not.toContain('自定义');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('explains a closed object without exposing its schema keyword', async () => {
    const page = objectConfigPage();
    const field = page.groups[0]!.fields[0]!;
    if (field.definition.type !== 'object') throw new Error('expected object fixture');
    field.definition.additionalProperties = false;
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configObjectPropertyEditor', pluginId: page.pluginId, layer: { scope: 'user' },
      fieldKey: 'settings', dynamic: true, stage: 'key',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, 'new-item', '\r');
    expect(instance.lastFrame()).toContain('这个设置不支持新增项目');
    expect(instance.lastFrame()).not.toContain('additionalProperty');
  });

  it('saves a closed true-only fixed boolean child and offers only missing KV custom values', async () => {
    const page = objectConfigPage();
    const field = page.groups[0]!.fields[0]!;
    if (field.definition.type !== 'object') throw new Error('expected object fixture');
    field.definition.properties = {
      enabled: {
        type: 'boolean',
        title: '启用模式',
        choices: {
          allowCustom: false,
          presets: [{ id: 'on', title: '仅开启', value: true, recommended: true }],
        },
      },
    };
    field.definition.additionalProperties = false;
    field.definition.validation = undefined;
    field.choices = undefined;
    field.allowCustom = true;
    field.draftValue = {};
    field.effectiveValue = {};
    const executeIntent = vi.fn().mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      executeIntent,
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor', pluginId: page.pluginId, layer: { scope: 'user' },
      fieldKey: 'settings', editor: 'object', mode: 'custom',
    });
    value.push({
      name: 'configObjectPropertyEditor', pluginId: page.pluginId, layer: { scope: 'user' },
      fieldKey: 'settings', propertyKey: 'enabled', dynamic: false, stage: 'choices',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('仅开启（推荐）');
    expect(instance.lastFrame()).not.toContain('○ 关闭');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', fieldKey: 'settings', editor: 'object',
    });
    expect(instance.lastFrame()).toContain('开启');
    await input(instance, '\u001B[B', '\r', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', pluginId: page.pluginId,
    });
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');
    expect(value.snapshot.activeReview?.operationKind).toBe('configSaveBatch');
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'configSaveBatch',
      groups: [expect.objectContaining({ scope: 'user', updates: { settings: { enabled: true } } })],
    }), expect.objectContaining(evidence));

    instance.unmount();
    const kvPage = objectConfigPage();
    const kvField = kvPage.groups[0]!.fields[0]!;
    if (kvField.definition.type !== 'object') throw new Error('expected object fixture');
    kvField.definition.properties = {};
    kvField.definition.additionalProperties = {
      type: 'boolean',
      choices: {
        allowCustom: true,
        presets: [{ id: 'on', title: 'KV 开启', value: true, recommended: true }],
      },
    };
    kvField.draftValue = { flag: true };
    kvField.effectiveValue = { flag: true };
    const kv = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...kvPage, pluginId, layer })),
    });
    kv.push({ name: 'configFields', pluginId: kvPage.pluginId, layer: { scope: 'user' } });
    kv.push({
      name: 'configObjectPropertyEditor', pluginId: kvPage.pluginId, layer: { scope: 'user' },
      fieldKey: 'settings', propertyKey: 'flag', dynamic: true, stage: 'choices',
    });
    const kvInstance = render(<ConsoleAppV4 controller={kv} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    const kvFrame = kvInstance.lastFrame() ?? '';
    expect(kvFrame).toContain('KV 开启（推荐）');
    expect(kvFrame).toContain('关闭');
    expect(kvFrame).not.toContain('○ 开启');
  });

  it('hides existing string children when either the parent or child is sensitive', async () => {
    const parentPage = objectConfigPage();
    const parentField = parentPage.groups[0]!.fields[0]!;
    parentField.sensitive = true;
    parentField.draftValue = { owner: 'PARENT-SECRET', region: 'west' };
    parentField.effectiveValue = parentField.draftValue;
    const parent = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...parentPage, pluginId, layer })),
    });
    parent.push({ name: 'configFields', pluginId: parentPage.pluginId, layer: { scope: 'user' } });
    const parentInstance = render(<ConsoleAppV4 controller={parent} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    parent.push({
      name: 'configObjectPropertyEditor',
      pluginId: parentPage.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      propertyKey: 'owner',
      dynamic: false,
      stage: 'custom',
    });
    await nextTurn(2);
    expect(parentInstance.lastFrame()).toContain('输入敏感值');
    expect(parentInstance.lastFrame()).toContain('输入已隐藏');
    expect(parentInstance.lastFrame()).not.toContain('PARENT-SECRET');

    parentInstance.unmount();
    const childPage = objectConfigPage();
    const child = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...childPage, pluginId, layer })),
    });
    child.push({ name: 'configFields', pluginId: childPage.pluginId, layer: { scope: 'user' } });
    const childInstance = render(<ConsoleAppV4 controller={child} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    child.push({
      name: 'configObjectPropertyEditor',
      pluginId: childPage.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      propertyKey: 'token',
      dynamic: false,
      stage: 'custom',
    });
    await nextTurn(2);
    expect(childInstance.lastFrame()).toContain('输入敏感值');
    expect(childInstance.lastFrame()).not.toContain('SECRET-BYTES');
  });

  it.each(['key', 'custom'] as const)('clears object property %s input with Ctrl-U without deleting the property', async (stage) => {
    const page = objectConfigPage();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    value.push({
      name: 'configObjectPropertyEditor', pluginId: page.pluginId, layer: { scope: 'user' },
      fieldKey: 'settings', ...(stage === 'custom' ? { propertyKey: 'owner' } : {}),
      dynamic: stage === 'key', stage,
    });
    await nextTurn(2);

    await input(instance, ...'temporary-value');
    expect(instance.lastFrame()).toContain('emporary-value');
    expect(instance.lastFrame()).toContain('Ctrl-U 清空输入');
    await input(instance, '\u0015');

    expect(instance.lastFrame()).not.toContain('emporary-value');
    expect(value.snapshot.router.current.route.name).toBe('configObjectPropertyEditor');
    expect(instance.lastFrame()).not.toContain('删除动态键');
  });

  it('keeps empty scalar and object numeric input in the editor while accepting explicit zero', async () => {
    const scalarPage = configPage();
    const timeout = scalarPage.groups[0]!.fields.find((field) => field.key === 'timeout')!;
    timeout.definition = { type: 'number', validation: { minimum: 0, maximum: 60 } };
    timeout.min = 0;
    const scalar = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...scalarPage, pluginId, layer })),
    });
    scalar.push({ name: 'configFields', pluginId: scalarPage.pluginId, layer: { scope: 'user' } });
    scalar.push({
      name: 'configFieldEditor', pluginId: scalarPage.pluginId, layer: { scope: 'user' },
      fieldKey: 'timeout', editor: 'number', mode: 'custom',
    });
    const scalarInstance = render(<ConsoleAppV4 controller={scalar} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(scalarInstance, '\u0015', '   ', '\r');
    expect(scalar.snapshot.router.current.route.name).toBe('configFieldEditor');
    expect(scalarInstance.lastFrame()).toContain('空输入不会保存为 0');
    await input(scalarInstance, '\u0015', '0', '\r');
    expect(scalar.snapshot.router.current.route.name).toBe('configLayer');
    expect(scalarInstance.lastFrame()).toContain('新值：0');
    scalarInstance.unmount();

    const objectPage = objectConfigPage();
    const objectField = objectPage.groups[0]!.fields[0]!;
    if (objectField.definition.type !== 'object') throw new Error('expected object fixture');
    objectField.definition.properties = {
      count: { type: 'number', title: '数量', validation: { minimum: 0 } },
    };
    objectField.definition.additionalProperties = false;
    objectField.draftValue = { count: 5 };
    objectField.effectiveValue = { count: 5 };
    const objectValue = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...objectPage, pluginId, layer })),
    });
    objectValue.push({ name: 'configFields', pluginId: objectPage.pluginId, layer: { scope: 'user' } });
    objectValue.push({
      name: 'configObjectPropertyEditor', pluginId: objectPage.pluginId, layer: { scope: 'user' },
      fieldKey: 'settings', propertyKey: 'count', dynamic: false, stage: 'custom',
    });
    const objectInstance = render(<ConsoleAppV4 controller={objectValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(objectInstance, '\u0015', '   ', '\r');
    expect(objectValue.snapshot.router.current.route.name).toBe('configObjectPropertyEditor');
    expect(objectInstance.lastFrame()).toContain('空输入不会保存为 0');
    await input(objectInstance, '\u0015', '0', '\r');
    expect(objectValue.snapshot.router.current.route.name).toBe('configFields');
  });

  it('keeps an empty string draft visible and submits it as set empty string', async () => {
    const page = configPage();
    const note = page.groups[0]!.fields.find((field) => field.key === 'note')!;
    Object.assign(note, {
      value: 'old note', draftValue: 'old note', displayValue: 'old note',
      configured: true, inherited: false,
    });
    const executeIntent = vi.fn().mockResolvedValue({
      configWrite: 'succeeded', overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      executeIntent,
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    value.push({
      name: 'configFieldEditor', pluginId: page.pluginId, layer: { scope: 'user' },
      fieldKey: 'note', editor: 'string', mode: 'custom',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\u0015', '\r');
    expect(value.snapshot.router.current.route.name).toBe('configLayer');
    expect(instance.lastFrame()).toContain('新值：（空字符串）');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).toContain('（空字符串）');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'configSaveBatch',
      groups: [expect.objectContaining({ updates: { note: '' }, removeKeys: [] })],
    }), expect.objectContaining(evidence));
  });

  it('does not project sensitive boolean or preset values as the current child choice', async () => {
    const page = objectConfigPage();
    const field = page.groups[0]!.fields[0]!;
    if (field.definition.type !== 'object') throw new Error('expected object fixture');
    field.definition.properties = {
      ...field.definition.properties,
      enabled: {
        type: 'boolean',
        title: '启用',
        sensitive: true,
        choices: {
          allowCustom: false,
          presets: [
            { id: 'on', title: '敏感开启', value: true },
            { id: 'off', title: '敏感关闭', value: false },
          ],
        },
      },
      mode: {
        type: 'string',
        title: '模式',
        sensitive: true,
        choices: {
          allowCustom: false,
          presets: [
            { id: 'fast', title: '快速方案', value: 'fast-secret' },
            { id: 'safe', title: '安全方案', value: 'safe-secret' },
          ],
        },
      },
    };
    field.draftValue = {
      owner: 'Alice',
      region: 'west',
      token: 'SECRET-BYTES',
      enabled: true,
      mode: 'fast-secret',
    };
    field.effectiveValue = field.draftValue;

    const booleanValue = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    booleanValue.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    booleanValue.push({
      name: 'configObjectPropertyEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      propertyKey: 'enabled',
      dynamic: false,
      stage: 'choices',
    });
    const booleanInstance = render(<ConsoleAppV4 controller={booleanValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    const booleanFrame = booleanInstance.lastFrame() ?? '';
    expect(booleanFrame).toContain('○ 敏感开启');
    expect(booleanFrame).toContain('○ 敏感关闭');
    expect(booleanFrame).not.toContain('● 敏感开启');

    booleanInstance.unmount();
    const choiceValue = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    choiceValue.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    choiceValue.push({
      name: 'configObjectPropertyEditor',
      pluginId: page.pluginId,
      layer: { scope: 'user' },
      fieldKey: 'settings',
      propertyKey: 'mode',
      dynamic: false,
      stage: 'choices',
    });
    const choiceInstance = render(<ConsoleAppV4 controller={choiceValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    const choiceFrame = choiceInstance.lastFrame() ?? '';
    expect(choiceFrame).toContain('○ 快速方案');
    expect(choiceFrame).toContain('○ 安全方案');
    expect(choiceFrame).not.toContain('● 快速方案');
    expect(choiceFrame).not.toContain('fast-secret');
  });

  it('reviews object unset with inherited preset and redacted child changes', async () => {
    const page = configuredObjectPage();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, 'u');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');

    expect(value.snapshot.activeReview?.operationKind).toBe('configSaveBatch');
    expect(value.snapshot.activeReview?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '个人默认 · 删除 服务设置 中的值',
        description: expect.stringContaining('已设置 · 3 项'),
      }),
    ]));
    expect(value.snapshot.activeReview?.changes[0]?.description).toContain('owner: Alice → Service');
    expect(value.snapshot.activeReview?.changes[0]?.description).toContain('token: 已设置 → 将更新');
    expect(JSON.stringify(value.snapshot.activeReview)).not.toContain('CURRENT-SECRET');
    expect(JSON.stringify(value.snapshot.activeReview)).not.toContain('preset-secret');
    expect(instance.lastFrame()).not.toContain('CURRENT-SECRET');
    expect(instance.lastFrame()).not.toContain('preset-secret');
  });

  it('reviews a valid layer reset with inherited object preset and redacted child changes', async () => {
    const page = configuredObjectPage();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await focusAction(instance, '设置选项');
    await input(instance, '\r');
    await focusAction(instance, '清空当前项目设置');
    await input(instance, '\r');
    await nextTurn(4);

    expect(value.snapshot.activeReview?.operationKind).toBe('configReset');
    expect(value.snapshot.activeReview?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '当前项目 · 服务设置',
        description: expect.stringContaining('已设置 · 3 项'),
      }),
    ]));
    expect(value.snapshot.activeReview?.changes[0]?.description).toContain('owner: Alice → Service');
    expect(value.snapshot.activeReview?.changes[0]?.description).toContain('token: 已设置 → 将更新');
    expect(JSON.stringify(value.snapshot.activeReview)).not.toContain('CURRENT-SECRET');
    expect(JSON.stringify(value.snapshot.activeReview)).not.toContain('preset-secret');
    expect(instance.lastFrame()).not.toContain('CURRENT-SECRET');
    expect(instance.lastFrame()).not.toContain('preset-secret');
  });

  it('returns editor completion or cancellation to the effective field and then restores the config origin', async () => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await focusAction(instance, '插件设置');
    await input(instance, '\r');
    await nextTurn(3);
    await input(instance, '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldEditor', fieldKey: 'level' });
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields',
      layer: { scope: 'effective' },
    });
    expect(value.snapshot.router.current.context).toMatchObject({ configGroupId: 'basic', focusIndex: 0 });

    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail',
      pluginId: 'team-tools/review-gate',
    });
    expect(instance.lastFrame()).toContain('› 插件设置');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'effective' },
    });
  });

  it.each([
    {
      label: 'preview primary action',
      previous: { name: 'pluginList', mode: 'browse' as const },
      origin: { name: 'pluginDetail', pluginId: 'official/review-gate' } as const,
      leaveResult: '\u001B',
    },
    {
      label: 'detail Esc',
      previous: { name: 'pluginList', mode: 'installed' as const },
      origin: { name: 'pluginDetail', pluginId: 'team-tools/review-gate' } as const,
      leaveResult: '\u001B',
    },
  ])('clears the mounted C12 settings flow for $label and preserves the original Back stack', async ({
    previous,
    origin,
    leaveResult,
  }) => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
      executeIntent: vi.fn().mockResolvedValue({
        status: 'succeeded',
        groups: [{
          scope: 'user', status: 'succeeded', configSaved: true,
          applyRequested: false, applyStatus: 'notRequested',
        }],
      }),
    });
    value.push(previous);
    value.push(origin);
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await nextTurn(4);

    await focusAction(instance, '插件设置');
    await input(instance, '\r');
    await nextTurn(3);
    await input(instance, '\r', '\u001B[B', '\r', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');
    await input(instance, '\r');
    await nextTurn(5);
    expect(screens).toContain('C12');

    if (leaveResult === '\u001B') {
      instance.stdin.write(leaveResult);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await nextTurn(2);
    } else {
      await input(instance, leaveResult);
    }
    expect(value.snapshot.router.current.route).toEqual(origin);
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual(previous);
  });

  it('treats Advanced as an ordinary tab without adding a route frame', async () => {
    const page = configPage();
    page.presets = [];
    page.groups = [
      { ...page.groups[0]!, fields: [page.groups[0]!.fields[3]!] },
      {
        id: 'advanced', title: '高级设置', advanced: true,
        fields: [{ ...page.groups[1]!.fields[0]!, title: '字段级高级模型' }],
      },
    ];
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...page, layer })) });
    value.push({
      name: 'configFields', pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);

    expect(screens).toContain('C01');
    expect(instance.lastFrame()).toContain('高级设置');
    expect(instance.lastFrame()).not.toContain('字段级高级模型');
    const depth = value.snapshot.router.depth;
    await input(instance, '\u001B[C');
    expect(value.snapshot.router.depth).toBe(depth);
    expect(value.snapshot.router.current.context.configGroupId).toBe('advanced');
    expect(instance.lastFrame()).toContain('字段级高级模型');
    expect(instance.lastFrame()).toContain('› 字段级高级模型');
  });

  it('preserves preset, manifest group, and advanced headings on the mutable settings page', async () => {
    const page = configPage();
    page.groups[0]!.fields = [page.groups[0]!.fields[0]!];
    const value = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...page, layer })) });
    value.push({
      name: 'configFields', pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('快速方案');
    expect(frame).toContain('基本设置');
    expect(frame).toContain('高级设置');
    expect(frame).not.toContain('设置字段');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
  });

  it('applies an effective preset to one selected target and preserves its draft across tabs', async () => {
    const page = configPage();
    page.presets[0]!.privateFieldTitles = ['token'];
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({
      name: 'configFields', pluginId: page.pluginId,
      layer: { scope: 'effective', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u001B[C', '\u001B[C');
    expect(value.snapshot.router.current.context.configGroupId).toBe('@presets');
    expect(instance.lastFrame()).toContain('› 团队默认');
    expect(instance.lastFrame()).toContain('token需手动输入');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configLayer', presetId: 'team' });
    await input(instance, '\r');
    await nextTurn(5);

    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', layer: { scope: 'effective' },
    });
    expect(value.snapshot.router.current.context).toMatchObject({ configGroupId: 'basic', focusIndex: 0 });
    expect(instance.lastFrame()).toContain('2 项待保存');
    expect(instance.lastFrame()).toContain('token需手动输入');
    await input(instance, '\u001B[C', '\u001B[C');
    expect(value.snapshot.router.current.context.configGroupId).toBe('@presets');
    await input(instance, '\r', '\r');
    expect(value.snapshot.router.current.context.configGroupId).toBe('basic');
    expect(instance.lastFrame()).toContain('2 项待保存');
    await input(instance, '\u001B[C');
    expect(instance.lastFrame()).toContain('2 项待保存');
    expect(instance.lastFrame()).toContain('› model');
    await input(instance, '\u001B[D');
    expect(instance.lastFrame()).toContain('待保存到当前项目');
    expect(instance.lastFrame()).toContain('2 项待保存');
    await input(instance, 's');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(instance.lastFrame()).toContain('确认保存设置');
    await chooseConfigSave(instance, value, 'only');
  });

  it('does not apply a preset after leaving its target picker while a target page is loading', async () => {
    const page = configPage();
    let resolveUser!: (page: ConfigPageViewModel) => void;
    const userPage = new Promise<ConfigPageViewModel>((resolve) => {
      resolveUser = resolve;
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => layer.scope === 'user'
        ? userPage
        : { ...page, pluginId, layer }),
    });
    value.push({
      name: 'configFields', pluginId: page.pluginId,
      layer: { scope: 'effective', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u001B[C', '\u001B[C', '\r', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configLayer', presetId: 'team',
    });
    await input(instance, 'b');
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', layer: { scope: 'effective', projectLayer: 'shared' },
    });

    await input(instance, '\r');
    resolveUser({ ...page, layer: { scope: 'user', projectLayer: 'shared' } });
    await nextTurn(5);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', fieldKey: 'level',
    });
    await input(instance, 'b');
    expect(instance.lastFrame()).toContain('严格');
    expect(instance.lastFrame()).not.toContain('项待保存');
  });

  it('shows one fallback plugin-settings tab when presentation groups are absent', async () => {
    const page = configPage();
    page.presets = [];
    page.groups = [{
      id: 'general', title: '插件设置', advanced: false,
      fields: [page.groups[0]!.fields[0]!],
    }];
    const value = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...page, layer })) });
    value.push({
      name: 'configFields', pluginId: page.pluginId,
      layer: { scope: 'effective', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('插件设置');
    expect(instance.lastFrame()).toMatch(/› level[^\n]*\[个人默认\]/u);
    expect(instance.lastFrame()).not.toContain('高级设置');
    expect(instance.lastFrame()).not.toContain('快速方案');
  });

  it('opens stored and unstored fields directly and offers unset in the editor', async () => {
    const page = configPage();
    const level = page.groups[0]!.fields[0]!;
    level.fallbackDisplayValue = '平衡';
    level.fallbackSourceLabel = '默认值';
    const value = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })) });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user', projectLayer: 'shared' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldEditor', fieldKey: 'level' });
    expect(instance.lastFrame()).toContain('恢复继承');
    await input(instance, 'b', ...Array.from({ length: 3 }, () => '\u001B[B'), '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldEditor', fieldKey: 'note' });
    expect(instance.lastFrame()).toContain('▌');
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
  ])('shows and unsets a legacy project native override at $columns x $rows', async (size) => {
    const page = configPage();
    page.layer = { scope: 'project' };
    page.storedCount = 1;
    const legacy = page.groups[0]!.fields[0]!;
    page.groups = [{
      id: 'basic', title: '基本设置', advanced: false,
      fields: [{
        ...legacy,
        title: '共享模式',
        writable: false,
        canSet: false,
        canUnset: true,
        sharedNativeRender: true,
        configured: true,
        inherited: false,
        displayValue: '旧项目值',
        effectiveDisplayValue: '个人默认值',
        effectiveSourceLabel: '个人默认',
        fallbackDisplayValue: '个人默认值',
        fallbackSourceLabel: '个人默认',
      }],
    }];
    const captureEvidence = vi.fn(async (intent: OperationIntent) => evidenceForIntent(intent));
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      captureEvidence,
    });
    value.push({
      name: 'configFields', pluginId: page.pluginId, layer: { scope: 'effective' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('共享模式');
    expect(instance.lastFrame()).toContain('个人默认值');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', fieldKey: legacy.key,
    });
    expect(instance.lastFrame()).not.toContain('修改值');
    expect(instance.lastFrame()).toContain('恢复继承');
    await input(instance, '\r');
    await chooseConfigTarget(instance, value, 'project');
    await openConfigSave(instance, value);
    await chooseConfigSave(instance, value, 'only');

    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'configSaveBatch',
      groups: [expect.objectContaining({
        scope: 'project', updates: {}, removeKeys: [legacy.key],
      })],
    }), expect.any(AbortSignal));
    expect(instance.lastFrame()).not.toContain('Shared impact 需要显式确认');
    instance.unmount();
  });

  it('does not present a user invalid override as a project-layer unset or fallback', async () => {
    const page = configPage();
    page.layer = { scope: 'project' };
    page.storedCount = 0;
    const inherited = page.groups[0]!.fields.find((field) => field.key === 'note')!;
    inherited.invalidOverrideIssue = '字段“note”在个人默认中的值无效。请切换到该设置层修改或删除此字段。';
    inherited.invalidOverrideOwnedByLayer = false;
    inherited.effectiveDisplayValue = '值无效';
    inherited.effectiveSourceLabel = '个人默认';
    const value = controller({ getConfigPage: vi.fn().mockResolvedValue(page) });
    value.push({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'project' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, ...Array.from({ length: 3 }, () => '\u001B[B'));

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('在个人默认中的值无效');
    expect(frame).toContain('切换到该设置层');
    expect(frame).not.toContain('删除后恢复');
    expect(frame).not.toContain('u 恢复继承');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', layer: { scope: 'effective' }, fieldKey: 'note',
    });
  });

  it.each([
    { columns: 80, rows: 24 },
    { columns: 60, rows: 18 },
  ])('shows shared native user-only fields as project read-only guidance at $columns x $rows', async (size) => {
    const page = configPage();
    const userOnly = page.groups[0]!.fields[0]!;
    userOnly.title = '共享等待窗口';
    userOnly.sharedNativeRender = true;
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => {
        const next = structuredClone(page);
        const field = next.groups[0]!.fields[0]!;
        if (layer.scope === 'project') {
          field.writable = false;
          field.canSet = false;
        }
        return { ...next, pluginId, layer };
      }),
    });
    value.push({
      name: 'configFields',
      pluginId: page.pluginId,
      layer: { scope: 'effective', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(4);

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', fieldKey: userOnly.key,
    });
    await focusAction(instance, '快速');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).toContain('仅可保存到个人默认');
    expect(instance.lastFrame()).not.toContain('› 当前项目');
    await chooseConfigTarget(instance, value, 'user');
    expect(instance.lastFrame()).toContain('待保存到个人默认');
  });

  it.each([
    ['configured enum', 'level', 'configFieldEditor', 0],
    ['unstored string', 'note', 'configFieldEditor', 3],
    ['configured secret', 'token', 'configFieldEditor', 6],
  ] as const)('routes an effective %s through the selected layer stored state', async (_label, fieldKey, expectedRoute, focusIndex) => {
    const page = configPage();
    const value = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })) });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'effective', projectLayer: 'shared' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, ...Array.from({ length: focusIndex }, () => '\u001B[B'));
    await input(instance, '\r');

    expect(value.snapshot.router.current.route).toMatchObject({ name: expectedRoute, fieldKey });
    if (fieldKey !== 'level') expect(instance.lastFrame()).toContain('▌');
  });

  it('stages a stored field removal without executing a write and shows inherited Review text', async () => {
    const page = configPage();
    const level = page.groups[0]!.fields[0]!;
    level.displayValue = `严格${'并保留当前项目的完整配置'.repeat(18)}。设置修改前唯一结尾。`;
    level.value = level.displayValue;
    level.draftValue = level.value;
    level.definition = { type: 'string' };
    level.fallbackDisplayValue = '平衡';
    level.fallbackSourceLabel = '个人默认';
    const executeIntent = vi.fn();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      executeIntent,
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'project', projectLayer: 'shared' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);

    await input(instance, 'u');
    await chooseConfigTarget(instance, value, 'project');
    expect(executeIntent).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('1 项待保存');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldEditor', fieldKey: 'level' });
    expect(instance.lastFrame()).toContain('恢复继承');
    await input(instance, 'b');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).toContain('1 项待保存');
    await openConfigSave(instance, value);
    expect(instance.lastFrame()).toContain('确认保存设置');
    expect(instance.lastFrame()).toContain('当前项目');
    expect(instance.lastFrame()).toContain('每层独立提交');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    expect(instance.lastFrame()).not.toContain('设置修改前唯一结尾');
    expect(value.snapshot.router.current.route.name).toBe('review');
    const detailPages: string[] = [];
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const frame = instance.lastFrame() ?? '';
      detailPages.push(frame);
      expect(frame.split('\n').length).toBeLessThanOrEqual(18);
      if (pageIndex > 0 && frame === detailPages.at(-2)) break;
      await input(instance, '\u001B[6~');
    }
    expect(detailPages.join('\n').replace(/\s/gu, '')).toContain('设置修改前唯一结尾');
    expect(detailPages.join('\n')).toContain('恢复继承（平衡 · 个人默认）');
    await input(instance, 'b');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it.each([
    ['secret', 'token'],
    ['path', 'rules'],
  ] as const)('renders a %s removal as a redacted inherited change', async (_label, fieldKey) => {
    const page = configPage();
    const field = page.groups.flatMap((group) => group.fields).find((candidate) => candidate.key === fieldKey)!;
    field.fallbackDisplayValue = '已设置';
    field.fallbackSourceLabel = '个人默认';
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    const layer = { scope: 'project' as const, projectLayer: 'shared' as const };
    value.push({ name: 'configFields', pluginId: page.pluginId, layer });
    value.push({ name: 'configFieldAction', pluginId: page.pluginId, layer, fieldKey });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u0012');
    await chooseConfigTarget(instance, value, 'project');
    await openConfigSave(instance, value);

    const frame = instance.lastFrame()!;
    expect(frame).toContain('当前项目');
    expect(frame).toContain(fieldKey);
    expect(frame).toContain('恢复继承（已设置 · 个人默认）');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(instance.lastFrame()).toContain('已设置');
    expect(frame).not.toContain('sk-private');
    expect(frame).not.toContain('/Users/private');
  });

  it('treats h, H, q, and b as config text, normalizes no-op drafts, and hides reset for an empty layer', async () => {
    const page = configPage();
    page.storedCount = 0;
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
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
    expect(instance.lastFrame()).toContain('Ctrl-U 清空输入');

    await input(instance, 'hHqb', '\r');
    await chooseConfigTarget(instance, value, 'user');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).toContain('1 项待保存');
    await openConfigSave(instance, value);
    expect(instance.lastFrame()).toContain('hHqb');

    await input(instance, 'b', '\u001B[B', '\r');
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    await nextTurn(4);
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'level',
      editor: 'enum',
    });
    await input(instance, '\u001B[B', '\u001B[B', '\r');
    await chooseConfigTarget(instance, value, 'user');
    await input(instance, ...Array.from({ length: 8 }, () => '\u001B[B'));
    expect(value.snapshot.activeReview).toBeUndefined();
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'note',
      editor: 'string',
    });
    await nextTurn(2);
    await input(instance, '\u0015', ...Array.from({ length: 8 }, () => '\u001B[B'));
    expect(value.snapshot.activeReview).toBeUndefined();
    await input(instance, 's', '\r');
    expect(value.snapshot.activeReview).toBeUndefined();
    expect(instance.lastFrame()).not.toContain('清空个人默认');
  });

  it('isolates private drafts by canonical plugin and layer before the next page renders', async () => {
    const alpha = configPage('team-tools/review-gate');
    const beta = configPage('official/agent-lab');
    beta.presets = [];
    beta.groups = [{
      id: 'basic',
      title: '基本设置',
      advanced: false,
      fields: [{
        ...beta.groups[0]!.fields[3]!,
        key: 'token',
        title: '普通 token 字段',
      }],
    }];
    const getConfigPage = vi.fn(async (pluginId: string, layer: ConfigPageViewModel['layer']) => ({
      ...(pluginId === alpha.pluginId ? alpha : beta),
      pluginId,
      layer,
    }));
    const value = controller({ getConfigPage });
    value.push({ name: 'configFields', pluginId: alpha.pluginId, layer: { scope: 'user', projectLayer: 'shared' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: alpha.pluginId,
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'token',
      editor: 'sensitive',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, 'LEAK-VALUE', '\r');

    value.replace({ name: 'configFields', pluginId: beta.pluginId, layer: { scope: 'user', projectLayer: 'shared' } });
    expect(instance.lastFrame()).not.toContain('LEAK-VALUE');
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('普通 token 字段');
    expect(instance.lastFrame()).not.toContain('LEAK-VALUE');
    await input(instance, 's', '\r');
    expect(value.snapshot.activeReview).toBeUndefined();
  });

  it('returns a removed config field route to its surviving layer', async () => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    await value.load();
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user' },
      fieldKey: 'removed-field',
      editor: 'string',
    });
    render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);

    expect(value.snapshot.router.current.route).toEqual({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user' },
    });
  });
});
