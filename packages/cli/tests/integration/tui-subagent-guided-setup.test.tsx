import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { PLATFORM_TARGETS } from '@lesliechan721/aw-plugin-core';

import { createCliExecutionContext } from '../../src/commands/runtime.js';
import type { PublicTargetResult } from '../../src/commands/public-lifecycle-result.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { resolvePreferencesPath } from '../../src/intent/deployment-preferences.js';
import type { CommandResult } from '../../src/output/public-result.js';
import * as discovery from '../../src/platforms/discovery.js';
import { getAgentPluginAdapter } from '../../src/platforms/registry.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { focusAction, input, nextTurn, confirmReview } from '../helpers/tui-console-app-input.js';
import { createCodexNativeTestRuntime } from '../helpers/write-command-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const guide = 'staged/agent-subagent';
const explorer = 'staged/agent-explore';
const advisor = 'staged/agent-advisor';

const codexBaseline = { executor: 'native', model: 'fixture-main', reasoningEffort: 'medium' };
const antigravityBaseline = { executor: 'native', model: 'gemini-4-neon-medium' };
const expectedProfiles = {
  codex: {
    generalTaskProfile: codexBaseline,
    simpleTaskProfile: { executor: 'native', model: 'fixture-mini', reasoningEffort: 'low' },
    complexTaskProfile: { executor: 'native', model: 'fixture-pro', reasoningEffort: 'high' },
    advancedTaskProfile: { executor: 'native', model: 'fixture-pro', reasoningEffort: 'xhigh' },
  },
  antigravity: {
    generalTaskProfile: antigravityBaseline,
    simpleTaskProfile: { executor: 'native', model: 'gemini-3.8-flash-low' },
    complexTaskProfile: { executor: 'native', model: 'gemini-4-neon-high' },
    advancedTaskProfile: { executor: 'native', model: 'gemini-4-neon-xhigh' },
  },
};
type GuidedPlatform = keyof typeof expectedProfiles;
const controllers = new Set<TuiController>();
afterEach(async () => {
  cleanup();
  for (const controller of controllers) {
    await controller.cancelAndWaitForReads();
    controller.dispose();
  }
  controllers.clear();
});

async function waitFrame(instance: ReturnType<typeof render>, label: string): Promise<void> {
  await vi.waitFor(() => expect(instance.lastFrame()).toContain(label), { timeout: 25_000 });
}

async function fixture() {
  installNativeTestQualification({ platforms: ['codex', 'antigravity'], discovery: true });
  const isolation = getCurrentSourceTestIsolation();
  const { env, layout: { fixtureCwd: cwd } } = isolation;
  await fs.ensureDir(path.join(cwd, '.git'));
  // TUI Agent settings also query machine-wide discovery (outside the
  // installation adapter). Supply controlled external client facts only.
  const discovered = vi.spyOn(discovery, 'discoverPlatforms').mockImplementation(async (context) =>
    Promise.all(PLATFORM_TARGETS.map(async (platform) =>
      platform === 'codex' || platform === 'antigravity' ? getAgentPluginAdapter(platform).discover(context) : {
        platform, installations: [], diagnostics: [], availability: platform === 'generic' ? 'notApplicable' : 'missing',
      })));
  onTestFinished(() => discovered.mockRestore());
  const codex = await createCodexNativeTestRuntime(isolation);
  const probeLog = path.join(cwd, 'directory-probes.jsonl');
  const bin = env.PATH!.split(path.delimiter)[0]!;
  const codexLauncher = await fs.realpath(path.join(bin, 'codex'));
  const codexModels = ['fixture-main', 'fixture-mini', 'fixture-pro'].map((model, index) => ({
    model, displayName: model, isDefault: index === 0, defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({ reasoningEffort })),
  }));
  // Execute the built provider and its actual host model-discovery protocol.
  // A marker counts model-directory requests, not UI calls or cache hits.
  await fs.writeFile(codexLauncher, [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'if (process.argv.includes("--version")) { console.log("codex-cli 0.200.0"); process.exit(0); }',
    'if (!process.argv.includes("app-server")) process.exit(2);',
    'const rl = require("node:readline").createInterface({ input: process.stdin });',
    'rl.on("line", line => {',
    ' const { id, method } = JSON.parse(line);',
    ' if (method === "initialize") console.log(JSON.stringify({ id, result: {} }));',
    ' else if (method === "model/list") {',
    `  fs.appendFileSync(${JSON.stringify(probeLog)}, "codex\\n");`,
    `  console.log(JSON.stringify({ id, result: { data: ${JSON.stringify(codexModels)}, nextCursor: null } }));`,
    ' } else if (method !== "initialized") process.exit(3);',
    '});',
  ].join('\n'));
  const agyModels = [
    'gemini-4-neon-low\tGemini 4 Neon (Low)',
    'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  ].join('\n');
  await fs.outputFile(path.join(bin, 'agy'), [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'if (process.argv[2] === "--version") console.log("1.3.4");',
    'else if (process.argv[2] === "models") {',
    ` fs.appendFileSync(${JSON.stringify(probeLog)}, "antigravity\\n");`,
    ` console.log(${JSON.stringify(agyModels)});`,
    '} else process.exit(3);',
  ].join('\n'), { mode: 0o755 });

  // Antigravity User installs use a native-copy manager. Observe real AW
  // projection bytes and emulate only the client-side copy and inventory.
  const copies = new Map<string, { name: string; version: string; path: string; enabled: boolean; source: string; skills: string[] }>();
  const nativeCliRunner = async (invocation: NativeCliInvocation) => {
    if (invocation.command !== 'antigravity') return codex.nativeCliRunner(invocation);
    const [command, action, resource] = invocation.args;
    expect(command).toBe('plugin');
    if (action === 'list') return { exitCode: 0, stderr: '', stdout: JSON.stringify([...copies.values()]) };
    if (action === 'install') {
      const { name, version } = await fs.readJson(path.join(resource!, '.antigravity-plugin/plugin.json'));
      const destination = path.join(discovery.resolvePlatformConfigRoot('antigravity', { cwd, env }), 'plugins', name);
      await fs.remove(destination);
      await fs.copy(resource!, destination);
      copies.set(name, { name, version, path: destination, enabled: true, source: 'antigravity',
        skills: await fs.readdir(path.join(destination, 'skills')).catch(() => []) });
    } else if (action === 'uninstall') {
      await fs.remove(copies.get(resource!)!.path);
      copies.delete(resource!);
    } else if (action === 'enable' || action === 'disable') {
      copies.get(resource!)!.enabled = action === 'enable';
    } else throw new Error('Unexpected Antigravity fixture invocation.');
    return { exitCode: 0, stderr: '', stdout: '' };
  };

  const catalog = path.join(cwd, 'shipped-catalog');
  const staged = fileURLToPath(new URL('../../plugins-dist/', import.meta.url));
  const manifest = await fs.readJson(path.join(staged, 'catalog-manifest.json'));
  const names = ['agent-subagent', 'agent-explore', 'agent-advisor'];
  const entries = manifest.entries.filter((entry: { name: string }) => names.includes(entry.name));
  expect(entries).toHaveLength(names.length);
  await Promise.all(names.map((name) => fs.copy(path.join(staged, 'plugins', name), path.join(catalog, 'plugins', name))));
  await fs.outputJson(path.join(catalog, 'catalog-manifest.json'), { ...manifest, entries });
  for (const relative of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']) {
    const marketplace = await fs.readJson(path.join(staged, relative));
    await fs.outputJson(path.join(catalog, relative), {
      ...marketplace, plugins: marketplace.plugins.filter((entry: { name: string }) => names.includes(entry.name)),
    });
  }
  const identity = `sha256:${'2'.repeat(64)}`;
  await fs.outputJson(path.join(catalog, '.aw-generated.json'), {
    schemaVersion: 1, kind: 'catalog', workspaceIdentity: identity, sourceIdentity: identity,
  });
  const invoke = (args: string[]) => runCliEntry([...args, '--json'], {
    cwd, env, interactive: false, nativeCliRunner,
  });
  const run = async <T extends object = Record<string, unknown>>(args: string[]) => {
    const result = await invoke(args);
    expect(result.exitCode, result.stdout || result.stderr).toBe(0);
    const receipt = result.parseJsonStdout<CommandResult<T>>();
    expect(receipt).toMatchObject({ schemaVersion: 2, status: 'success' });
    return receipt.data;
  };
  await run(['source', 'add', 'staged', '--path', catalog, '--primary', '--no-auto-check', '--yes']);
  await run(['source', 'sync', 'staged', '--yes']);
  await run(['target', 'set', 'codex', 'antigravity', '--force', '--context', 'user']);
  const location = { cwd, env, scope: 'user' as const };
  const store = (pluginId: string) => resolvePluginConfigStorePath({
    ...location, sourceId: 'staged', pluginName: pluginId.split('/').at(-1)!,
  });
  const config = ['plugin', 'config'];
  const set = (pluginId: string, field: string, value: unknown, platform?: string) => run([
    ...config, 'set', pluginId, field, '--context', 'user',
    ...(platform ? ['--platform', platform] : []), '--value-json', JSON.stringify(value),
  ]);
  const get = (pluginId: string, field: string, platform: string) => run([
    ...config, 'get', pluginId, field, '--context', 'user', '--platform', platform,
  ]);
  const readProbes = async () => (await fs.readFile(probeLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  async function mount(pluginId: string) {
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd, env, interactive: false, nativeCliRunner,
    })));
    controllers.add(controller);
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId });
    const screen = render(<ConsoleAppV4 controller={controller} size={{ columns: 120, rows: 44 }} />);
    await nextTurn(4);
    return { controller, screen };
  }
  const status = async () => {
    const result = await invoke(['plugin', 'status', '--context', 'user']);
    const receipt = result.parseJsonStdout<CommandResult<{
      inventory: Array<{ pluginId: string; targetResults: PublicTargetResult[] }>;
    }>>();
    expect(result.exitCode).toBe(receipt.status === 'success' ? 0 : 4);
    return receipt;
  };
  return { location, invoke, run, set, get, store, readProbes, mount, status, copies, codex };
}

async function startInstall(screen: ReturnType<typeof render>): Promise<void> {
  await vi.waitFor(() => expect(screen.lastFrame()).not.toContain('请先选择 Agent'), { timeout: 25_000 });
  await focusAction(screen, '添加插件…');
  await input(screen, '\r');
  await waitFrame(screen, '选择使用范围');
  await input(screen, '\r');
  await vi.waitFor(() => expect(screen.lastFrame()).toMatch(/需要初始化平台配置|恢复结果|确认恢复可执行目标/), { timeout: 25_000 });
  if (screen.lastFrame()?.includes('恢复结果')) {
    await input(screen, 'd');
  }
  expect(screen.lastFrame()).toContain('需要初始化平台配置');
}

async function finishInstall(screen: ReturnType<typeof render>): Promise<void> {
  await waitFrame(screen, '确认恢复可执行目标');
  await input(screen, '\r');
  await vi.waitFor(() => expect(screen.lastFrame()).toMatch(/确认并执行|正在执行恢复|恢复结果/), { timeout: 25_000 });
  if (screen.lastFrame()?.includes('确认并执行')) {
    await focusAction(screen, '确认并执行');
    await input(screen, '\r');
  }
  await waitFrame(screen, '恢复结果');
  expect(screen.lastFrame()).toContain('请求已完成');
}

// Windows needs the packaged Job helper for actual suggestions/renderer child
// processes; like the dist probe contract, exercise them on POSIX runners.
// Test Value Gate: real manifests, provider protocol and UI wiring together
// across dependency-first guided setup, Store confirmation and native output.
it.skipIf(process.platform === 'win32')('initializes both platforms for the real explorer dependency and clears inactive layers', async () => {
  const f = await fixture();
  const { controller, screen } = await f.mount(explorer);
  await startInstall(screen);
  expect(screen.lastFrame()).toContain(guide);
  expect(screen.lastFrame()).toContain('generalTaskProfile');
  expect(screen.lastFrame()).not.toContain('跳过未配置平台');
  expect(await fs.pathExists(f.store(guide))).toBe(false);
  expect(await observeIntent(f.location)).toMatchObject({ state: 'absent' });

  await input(screen, '\r');
  const completed = new Set<GuidedPlatform>();
  for (let index = 0; index < 2; index++) {
    await vi.waitFor(() => {
      expect(controller.snapshot.router.current.route).toMatchObject({ name: 'configFields', pluginId: guide });
      expect(screen.lastFrame()).toContain('推荐预选 · 待确认');
      expect(screen.lastFrame()).toContain('1 项待保存');
    }, { timeout: 25_000 });
    const route = controller.snapshot.router.current.route;
    if (route.name !== 'configFields') throw new Error('Expected guided configuration.');
    const platform = route.layer.profile as GuidedPlatform;
    expect(completed.has(platform)).toBe(false);
    const before = await fs.readFile(f.store(guide)).catch(() => undefined);
    expect((await f.readProbes()).filter((target) => target === platform)).toEqual([platform]);
    // Optional fill must reuse the same real directory; no additional host request.
    await input(screen, 'a');
    await focusAction(screen, '按推荐预填全部可选档位');
    await input(screen, '\r');
    await waitFrame(screen, '4 项待保存');
    expect((await f.readProbes()).filter((target) => target === platform)).toEqual([platform]);
    expect(await fs.readFile(f.store(guide)).catch(() => undefined)).toEqual(before);
    await nextTurn(3);
    await vi.waitFor(() => expect(screen.lastFrame()).not.toMatch(/正在读取引用来源|正在读取推荐或引用来源/), { timeout: 25_000 });
    await input(screen, 's');
    await vi.waitFor(async () => {
      expect(await fs.pathExists(f.store(guide)), screen.lastFrame()).toBe(true);
      expect(await fs.readJson(f.store(guide))).toMatchObject({
        schemaVersion: 6, common: {}, platforms: { [platform]: expectedProfiles[platform] },
      });
    }, { timeout: 25_000 });
    completed.add(platform);
  }
  expect(completed).toEqual(new Set(['codex', 'antigravity']));
  expect(await f.readProbes()).toEqual(expect.arrayContaining(['codex', 'antigravity']));
  expect(await f.readProbes()).toHaveLength(2);
  await waitFrame(screen, '确认恢复可执行目标');
  expect(await observeIntent(f.location)).toMatchObject({ state: 'absent' });
  await finishInstall(screen);
  expect(await observeIntent(f.location)).toMatchObject({ state: 'valid', value: { roots: [{ pluginId: explorer }] } });
  expect(await fs.pathExists(f.store(explorer))).toBe(false);
  expect(f.copies.size).toBe(2);
  expect([...f.copies.values()].flatMap((copy) => copy.skills)).toEqual(expect.arrayContaining(['spawn-subagent', 'explore-facts']));
  const ready = await f.status();
  expect(ready.status).toBe('success');
  expect(ready.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'requiredConfigMissing' }));

  screen.unmount();
  // The third real plugin needs no setup of its own.
  await f.run(['plugin', 'install', advisor, '--scope', 'user', '--yes']);
  expect(await fs.pathExists(f.store(advisor))).toBe(false);
  expect([...f.copies.values()].flatMap((copy) => copy.skills)).toContain('consult-advisor');

  // Keep Antigravity's stored references, disable that platform, and remove
  // the common executor. Its historical layers must not veto active writes.
  const registry = [{ key: 'historical-fixture', adapter: 'codex', modelsPolicy: 'override',
    models: [{ id: 'fixture-external' }] }];
  await f.set(guide, 'subagentCommands', registry);
  await f.set(guide, 'generalTaskProfile', { executor: 'historical-fixture' }, 'antigravity');
  await f.set(advisor, 'advisorProfile', { executor: 'historical-fixture' }, 'antigravity');
  await f.run(['target', 'set', 'codex', '--context', 'user']);
  await f.set(guide, 'subagentCommands', []);
  const activeOverride = { executor: 'native', model: 'fixture-main', reasoningEffort: 'low' };
  await f.set(guide, 'simpleTaskProfile', activeOverride, 'codex');
  const inactiveStatus = await f.status();
  expect(inactiveStatus.diagnostics.filter(({ code, subject }) =>
    subject?.target === 'antigravity' && ['requiredConfigMissing', 'configInvalid', 'invalidConfig'].includes(code))).toEqual([]);
  const historical = await f.get(advisor, 'advisorProfile', 'antigravity');
  expect(historical).toMatchObject({ fields: [expect.objectContaining({
    key: 'advisorProfile', storedValue: { executor: 'historical-fixture' }, canUnset: true,
  })] });
  const denied = await f.invoke(['plugin', 'config', 'set', advisor, 'advisorProfile', '--platform', 'antigravity',
    '--context', 'user', '--value-json', '{"executor":"native"}']);
  expect(denied.exitCode).toBe(3);
  expect(denied.parseJsonStdout()).toMatchObject({ status: 'blocked',
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'configPlatformNotEnabled' })]) });

  const residue = await f.mount(guide);
  await focusAction(residue.screen, '插件设置');
  await input(residue.screen, '\r');
  await waitFrame(residue.screen, '历史残留层（1 个）');
  await focusAction(residue.screen, '历史残留层（1 个）');
  await input(residue.screen, '\r');
  await waitFrame(residue.screen, '重置Antigravity');
  expect(residue.screen.lastFrame()).toContain('generalTaskProfile');
  expect(residue.screen.lastFrame()).not.toContain('historical-fixture');
  await input(residue.screen, '\r');
  await vi.waitFor(() => expect(residue.controller.snapshot.router.current.route.name).toBe('review'));
  await confirmReview(residue.screen, residue.controller);
  await vi.waitFor(async () => expect((await fs.readJson(f.store(guide))).platforms.antigravity).toBeUndefined(), { timeout: 25_000 });
  expect((await fs.readJson(f.store(guide))).platforms.codex).toEqual({
    ...expectedProfiles.codex, simpleTaskProfile: activeOverride,
  });
  await f.run(['plugin', 'config', 'reset', advisor, '--context', 'user', '--platform', 'antigravity', '--yes']);
  expect(await fs.pathExists(f.store(advisor))).toBe(false);
}, 120_000);

// Test Value Gate: skip is a filtered output operation, not a target exclusion
// or partial declaration. Observe the actual Intent and absent native copies.
it.skipIf(process.platform === 'win32')('skips the unconfigured dependency platform without excluding or losing global Intent', async () => {
  const f = await fixture();
  await f.set(guide, 'generalTaskProfile', { executor: 'native' }, 'codex');
  const preferencePath = await resolvePreferencesPath(f.location);
  const before = await fs.readFile(preferencePath);
  const { screen } = await f.mount(explorer);
  await startInstall(screen);
  expect(screen.lastFrame()).toContain('Antigravity');
  expect(screen.lastFrame()).toContain(guide);
  await focusAction(screen, '跳过未配置平台，仅继续已就绪平台');
  await input(screen, '\r');
  await waitFrame(screen, '确认恢复可执行目标');
  expect(screen.lastFrame()).toContain('requiredConfigMissing');
  expect(screen.lastFrame()).toContain('跳过未配置平台');
  await finishInstall(screen);
  expect(screen.lastFrame()).toContain('requiredConfigMissing');
  expect(screen.lastFrame()).toContain('跳过未配置平台');
  expect(await fs.readFile(preferencePath)).toEqual(before);
  expect(await observeIntent(f.location)).toMatchObject({ state: 'valid', value: { roots: [{ pluginId: explorer }] } });
  expect((await fs.readJson(f.store(guide))).platforms).toEqual({ codex: { generalTaskProfile: { executor: 'native' } } });
  expect(await f.readProbes()).toEqual([]);
  expect([...f.copies.values()]).toEqual([]);
  expect([...f.codex.packageRoots.keys()].map((id) => id.split('@')[0]).sort()).toEqual(['agent-explore', 'agent-subagent']);
  const status = await f.status();
  expect(status.status).toBe('partial');
  expect(status.diagnostics).toContainEqual(expect.objectContaining({
    code: 'requiredConfigMissing', subject: { pluginId: guide, target: 'antigravity', scope: 'user' },
    detail: { reasonCode: 'missingRequired', fieldKeys: ['generalTaskProfile'] },
  }));
  expect(status.data).toMatchObject({ inventory: expect.arrayContaining([
    expect.objectContaining({ pluginId: explorer, targetResults: expect.arrayContaining([
      expect.objectContaining({ target: 'codex', content: 'satisfied' }),
      expect.objectContaining({ target: 'antigravity', execution: 'not-run', blockerCodes: ['requiredConfigMissing'] }),
    ]) }),
  ]) });
}, 120_000);
