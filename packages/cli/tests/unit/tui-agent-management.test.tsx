import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_TARGETS } from '@lesliechan721/aw-plugin-core';
import stringWidth from 'string-width';
import { AgentManagement } from '../../src/tui/agent-management.js';
import type { AgentSettings, AgentSettingsPreview } from '../../src/tui/agent-settings.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { targetAvailabilityViews, TargetSelectionConfirmationRequiredError, type Availability } from '../../src/platforms/discovery.js';
import { controller, deferred, agentSettings } from '../helpers/tui-console-app-fixture.js';
import { input, escape, nextTurn, focusAction, acceptanceTraceStep, writeAcceptanceTrace } from '../helpers/tui-console-app-input.js';

afterEach(cleanup);
const agentNames = ['Codex', 'Claude Code', 'Antigravity', 'Cursor', 'OpenCode', 'Pi', 'Gemini CLI', 'GitHub Copilot CLI', 'Grok Build', 'Generic'];
const empty = (): AgentSettings => ({ preferences: createEmptyPreferences(), revision: 'absent',
  availability: agentSettings().availability,
  context: 'user', plugins: [{ pluginId: 'local/demo', scopes: ['user'], supportedTargets: ['codex', 'cursor'] }] });
const observed = (states: Partial<Record<string, Availability>>, targets: AgentSettings['preferences']['targets'] = []): AgentSettings => ({ ...empty(),
  preferences: { ...createEmptyPreferences(), targets },
  availability: targetAvailabilityViews(PLATFORM_TARGETS.map((platform) => ({ platform,
    availability: states[platform] ?? (platform === 'generic' ? 'notApplicable' : 'missing'), installations: [], diagnostics: [] })), targets) });
const preview: AgentSettingsPreview = { blocked: false, reasons: [], conflicts: [], counts: { codex: 1 } };
const callbacks = () => ({ onBack: vi.fn(), onExit: vi.fn(), onSaved: vi.fn(), onSync: vi.fn() });

describe('Agent management interaction', () => {
  // Test Value Gate: initialization must remain a draft; generic is manual and unavailable clients require a default-cancel confirmation.
  it('preselects only available clients once and confirms new unavailable choices', async () => {
    const settings = observed({ codex: 'available' });
    const inspect = vi.fn(async () => preview); const save = vi.fn(async () => settings);
    const value = controller({ previewAgentSettings: inspect, saveAgentSettings: save });
    const instance = render(<AgentManagement controller={value} settings={settings} columns={80} rows={24} {...callbacks()} />);
    await nextTurn(5);
    expect(inspect.mock.calls.at(-1)?.[0].targets).toEqual(['codex']); expect(save).not.toHaveBeenCalled();
    await input(instance, ' '); await nextTurn(3);
    expect(inspect.mock.calls.at(-1)?.[0].targets).toEqual([]);
    await input(instance, '\u001b[B', ' '); await nextTurn(3);
    expect(inspect.mock.calls.at(-1)?.[0].targets).toEqual(['generic']);
    await input(instance, '\u001b[B', ' '); expect(instance.lastFrame()).toContain('› 取消');
    await input(instance, '\r'); await nextTurn(3);
    expect(inspect.mock.calls.at(-1)?.[0].targets).toEqual(['generic']);
    await input(instance, ' ', '\u001b[B', '\r'); await nextTurn(3);
    expect(inspect.mock.calls.at(-1)?.[0].targets).toEqual(['claude', 'generic']);
    value.dispose();
  });

  // Test Value Gate: reordered probe results cannot change the selected draft or move keyboard focus to another client.
  it('keeps the draft and focused target when refresh reorders availability', async () => {
    const initial = observed({ codex: 'available', cursor: 'available' });
    const refreshed = observed({ codex: 'available' });
    const inspect = vi.fn(async () => preview);
    const value = controller({ previewAgentSettings: inspect, readAgentSettings: vi.fn(async () => refreshed) });
    const instance = render(<AgentManagement controller={value} settings={initial} columns={80} rows={24} {...callbacks()} />);
    await nextTurn(5); await input(instance, '\u001b[B', 'r'); await nextTurn(5);
    expect(instance.lastFrame()).toContain('› ◆ Cursor');
    expect(inspect.mock.calls.at(-1)?.[0].targets).toEqual(['codex', 'cursor']);
    await input(instance, ' '); await nextTurn(3);
    expect(inspect.mock.calls.at(-1)?.[0].targets).toEqual(['codex']); value.dispose();
  });

  // Test Value Gate: a client that deteriorates before saving needs an additional confirmation and cannot write on default Enter.
  it('asks again when the save-time client check deteriorates', async () => {
    const initial = observed({ codex: 'available' });
    const deteriorated = observed({ codex: 'unknown' });
    const save = vi.fn().mockRejectedValueOnce(new TargetSelectionConfirmationRequiredError([deteriorated.availability.find((item) => item.id === 'codex')!]))
      .mockResolvedValue({ ...initial, revision: 'saved', preferences: { ...initial.preferences, targets: ['codex'] } });
    const value = controller({ previewAgentSettings: vi.fn(async () => preview), saveAgentSettings: save });
    const handlers = callbacks();
    const instance = render(<AgentManagement controller={value} settings={initial} columns={80} rows={24} {...handlers} />);
    await nextTurn(5); await input(instance, 's'); await nextTurn(5);
    expect(instance.lastFrame()).toContain('Codex：无法确认'); expect(instance.lastFrame()).toContain('› 取消');
    await input(instance, '\u001b[B', '\r'); await nextTurn(5);
    expect(save.mock.calls.at(-1)?.[0].confirmedUnavailableTargets).toEqual(['codex']);
    expect(handlers.onSaved).toHaveBeenCalledOnce(); expect(instance.lastFrame()).toContain('已保存，是否同步'); value.dispose();
  });
  it('keeps all selected Agents and the project visible at the minimum size', async () => {
    const value = controller({ readAgentSettings: vi.fn(async () => agentSettings([...PLATFORM_TARGETS])) });
    await value.load();
    const size = { columns: 60, rows: 18 };
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(8);
    for (const label of agentNames) expect(instance.lastFrame()).toContain(label);
    expect(instance.lastFrame()).toContain('当前项目  workspace');
    await writeAcceptanceTrace('platform-targets-home-seven', [acceptanceTraceStep(instance, size, 'seven Agents and project')]);
    value.dispose();
  });

  it('does not execute a prepared write after the terminal becomes too small', async () => {
    const execute = vi.fn(async () => ({ kind: 'intent' as const, changed: true }));
    const value = controller({ executeScopedTask: execute });
    await value.load(); value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const app = (columns: number, rows: number) => <ConsoleAppV4 controller={value} size={{ columns, rows }} />;
    const instance = render(app(60, 18)); await nextTurn(8);
    await focusAction(instance, '加入插件清单（暂不安装）', 80);
    await input(instance, '\r', '\r'); await nextTurn(8);
    expect(instance.lastFrame()).toContain('确认');
    instance.rerender(app(59, 17)); await nextTurn(4);
    await input(instance, '\r', 's', ' '); await nextTurn(4);
    expect(execute).not.toHaveBeenCalled();
    instance.rerender(app(60, 18)); await nextTurn(4);
    await input(instance, '\r'); await nextTurn(8);
    expect(execute).toHaveBeenCalledOnce(); value.dispose();
  });

  it('explains affected plugins and exposes conflict paths separately', async () => {
    const value = controller({ previewAgentSettings: vi.fn(async () => ({ ...preview,
      conflicts: [{ targets: ['cursor', 'generic'] as const,
        message: 'Cursor 与 Generic 使用冲突的 Skill 目录。', plugins: ['local/demo'],
        technical: ['/test/home/.agents/skills', 'local/demo',
          ...Array.from({ length: 8 }, (_, index) => `目录依据 ${index + 3}`)] }],
    })) });
    const settings = empty();
    const component = (columns: number, rows: number) => <AgentManagement controller={value} settings={settings}
      columns={columns} rows={rows} {...callbacks()} />;
    const instance = render(component(60, 18));
    await nextTurn(8);
    for (let index = 0; index < PLATFORM_TARGETS.length + 1; index++) await input(instance, '\u001b[B');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('影响插件：demo');
    expect(instance.lastFrame()).not.toContain('/test/home');
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('/test/home/.agents/skills');
    expect(instance.lastFrame()).toContain('local/demo');
    for (let index = 0; index < 12; index++) await input(instance, '\u001b[B');
    expect(instance.lastFrame()).toContain('目录依据 10');
    instance.rerender(component(80, 24)); await nextTurn(4);
    expect(instance.lastFrame()).toContain('目录依据 10');
    expect(instance.lastFrame()).toContain('/test/home/.agents/skills');
    await escape(instance);
    expect(instance.lastFrame()).toContain('影响插件：demo'); value.dispose();
  });
  it.each([[60,18], [80,24], [120,40]])('keeps targets and save reachable at %ix%i and after resize', async (columns, rows) => {
    const value = controller({ previewAgentSettings: vi.fn(async () => preview) });
    const settings = empty(); const handlers = callbacks();
    const component = (c: number, r: number) => <AgentManagement controller={value} settings={settings}
      columns={c} rows={r} {...handlers} />;
    const instance = render(component(columns, rows)); await nextTurn(5);
    for (const name of agentNames) {
      expect(instance.lastFrame()).toContain(`› ${name === 'Generic' ? '◇' : '◆'} ${name}`);
      await input(instance, '\u001b[B');
    }
    expect(instance.lastFrame()).toContain('› 保存');
    instance.rerender(component(60,18)); await nextTurn(3);
    expect(instance.lastFrame()).toContain('› 保存');
    const frame = instance.lastFrame()!;
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
    expect(Math.max(...frame.split('\n').map(stringWidth))).toBeLessThanOrEqual(60); value.dispose();
  });

  it('waits for save, then isolates the default sync dialog from background shortcuts', async () => {
    const pending = deferred<AgentSettings>(); const save = vi.fn(async () => pending.promise);
    const value = controller({ previewAgentSettings: vi.fn(async () => preview), saveAgentSettings: save });
    const handlers = callbacks(); const settings = empty();
    const instance = render(<AgentManagement controller={value} settings={settings} columns={60} rows={18} {...handlers} />);
    await nextTurn(5); await input(instance, ' ', 's'); await nextTurn(3);
    expect(save).toHaveBeenCalledOnce(); expect(instance.lastFrame()).not.toContain('已保存，是否同步');
    pending.resolve({ ...settings, revision: 'saved', preferences: { ...settings.preferences, targets: ['codex'] } });
    await nextTurn(5); expect(instance.lastFrame()).toContain('已保存，是否同步？');
    await input(instance, 's', ' ', 'h');
    expect(save).toHaveBeenCalledOnce(); expect(handlers.onBack).not.toHaveBeenCalled();
    await input(instance, '\r'); expect(handlers.onSync).toHaveBeenCalledOnce(); value.dispose();
  });

  it('blocks required exclusions, protects unavailable rows, and retains saved policy on Escape', async () => {
    const settings = empty(); settings.preferences.targets = ['codex'];
    const inspect = vi.fn(async (draft) => draft.exclusions.length ? { ...preview, blocked: true,
      reasons: [{ target: 'codex' as const, root: 'local/parent', scope: 'project' as const,
        path: ['local/parent','local/demo'], message: 'parent needs demo' }] } : preview);
    const save = vi.fn(async () => settings);
    const value = controller({ previewAgentSettings: inspect, saveAgentSettings: save }); const handlers = callbacks();
    const instance = render(<AgentManagement controller={value} settings={settings} pluginId="local/demo"
      columns={60} rows={18} {...handlers} />);
    await nextTurn(5); await input(instance, ' '); await nextTurn(5); await input(instance, 's');
    expect(save).not.toHaveBeenCalled(); expect(instance.lastFrame()).toContain('parent 需要');
    await input(instance, ' '); await nextTurn(5); await input(instance, '\u001b[B', ' ', 's'); await nextTurn(5);
    expect(save).toHaveBeenCalledOnce(); expect(inspect.mock.calls.at(-1)![0].exclusions).toEqual([]);
    await input(instance, '\u001b'); expect(handlers.onSync).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(instance.lastFrame()).not.toContain('已保存，是否同步')); value.dispose();
  });

  it('keeps session keys available and confirms navigation before discarding changes', async () => {
    const value = controller({ previewAgentSettings: vi.fn(async () => preview) });
    const handlers = { ...callbacks(), onHome: vi.fn(), onReload: vi.fn(), onHelp: vi.fn() };
    const instance = render(<AgentManagement controller={value} settings={observed({}, ['codex'])}
      columns={60} rows={18} {...handlers} />);
    await nextTurn(5); await input(instance, '?', 'H', 'q');
    expect(handlers.onHelp).toHaveBeenCalledOnce(); expect(handlers.onReload).toHaveBeenCalledOnce();
    expect(handlers.onExit).toHaveBeenCalledOnce();
    await input(instance, ' ', 'h'); expect(handlers.onHome).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('还有未保存的修改');
    await input(instance, '\u001b[B', '\r'); expect(handlers.onHome).toHaveBeenCalledOnce();
    value.dispose();
  });

  it('welcomes an empty session once and blocks background home input', async () => {
    const execute = vi.fn();
    const value = controller({ readAgentSettings: vi.fn(async () => empty()), executeIntent: execute,
      previewAgentSettings: vi.fn(async () => preview) }); await value.load();
    const size = { columns:60, rows:18 };
    const instance = render(<ConsoleAppV4 controller={value} size={size} />); await nextTurn(6);
    expect(instance.lastFrame()).toContain('欢迎使用 AW');
    const trace = [acceptanceTraceStep(instance,size,'empty-target welcome')];
    await input(instance, 'm','s','h'); expect(value.snapshot.router.current.route.name).toBe('home');
    expect(execute).not.toHaveBeenCalled(); await input(instance, '\u001b'); await nextTurn(3);
    await vi.waitFor(() => expect(instance.lastFrame()).not.toContain('欢迎使用 AW')); expect(instance.lastFrame()).toContain('Agent 管理');
    trace.push(acceptanceTraceStep(instance,size,'four home entries'));
    await input(instance, '\r', '\u001b'); await nextTurn(4);
    expect(instance.lastFrame()).not.toContain('欢迎使用 AW');
    await writeAcceptanceTrace('platform-targets-home',trace); value.dispose();
  });
});
