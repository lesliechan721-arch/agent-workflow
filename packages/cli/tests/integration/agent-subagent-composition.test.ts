import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { expect, it } from 'vitest';

import type { LifecycleData } from '../../src/commands/public-lifecycle-result.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { createCodexNativeTestRuntime } from '../helpers/write-command-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const guide = 'staged/agent-subagent';
const explorer = 'staged/agent-explore';
const advisor = 'staged/agent-advisor';

// Test Value Gate: exercise the actual shipped dependency graph, renderer,
// same-source suggestions provider and active-platform reference protection together.
it('installs the three subagent plugins, uses their shared provider, and protects only active references', async () => {
  installNativeTestDiscovery({ platforms: ['codex', 'claude'] });
  const isolation = getCurrentSourceTestIsolation();
  const { env, layout: { fixtureCwd: cwd } } = isolation;
  await fs.ensureDir(path.join(cwd, '.git'));
  const runtime = await createCodexNativeTestRuntime(isolation);
  const catalog = path.join(cwd, 'shipped-catalog');
  const staged = fileURLToPath(new URL('../../plugins-dist/', import.meta.url));
  const manifest = await fs.readJson(path.join(staged, 'catalog-manifest.json'));
  const names = ['agent-subagent', 'agent-explore', 'agent-advisor'];
  // Use the actual built bundles and their original integrity entries, without
  // revalidating unrelated plugins on every CLI read or mutation.
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
  const identity = `sha256:${'1'.repeat(64)}`;
  await fs.outputJson(path.join(catalog, '.aw-generated.json'), {
    schemaVersion: 1, kind: 'catalog', workspaceIdentity: identity, sourceIdentity: identity,
  });
  const invoke = (args: string[]) => runCliEntry([...args, '--json'], {
    cwd, env, interactive: false, nativeCliRunner: runtime.nativeCliRunner,
  });
  const run = async <T = unknown>(args: string[]): Promise<T> => {
    const result = await invoke(args);
    expect(result.exitCode, result.stdout || result.stderr).toBe(0);
    const receipt = result.parseJsonStdout<{ schemaVersion: number; status: string; data: T }>();
    expect(receipt).toMatchObject({ schemaVersion: 2, status: 'success' });
    return receipt.data;
  };
  const config = ['plugin', 'config'];
  const set = (pluginId: string, field: string, value: unknown, platform?: string) => [
    ...config, 'set', pluginId, field, '--context', 'user',
    ...(platform ? ['--platform', platform] : []), '--value-json', JSON.stringify(value),
  ];
  await run(['source', 'add', 'staged', '--path', catalog, '--primary', '--no-auto-check', '--yes']);
  await run(['source', 'sync', 'staged', '--yes']);
  await run(['target', 'set', 'codex', 'claude', '--force', '--context', 'user']);
  await run(set(guide, 'generalTaskProfile', { executor: 'native' }, 'codex'));
  await run(set(guide, 'generalTaskProfile', { executor: 'native' }, 'claude'));

  // Only the Guide requires initial configuration. The consumers are installed
  // without saving any own profile and share its command/package ownership.
  const installation = await run<LifecycleData>([
    'plugin', 'install', guide, explorer, advisor, '--scope', 'user', '--target', 'codex', '--yes',
  ]);
  expect(installation.remainingTargets).toEqual([]);
  expect(installation.targetResults).toEqual(expect.arrayContaining([guide, explorer, advisor].map((pluginId) =>
    expect.objectContaining({ pluginId, target: 'codex', scope: 'user', execution: 'applied' }))));
  expect(installation.targetResults).toHaveLength(3);
  for (const [plugin, skill] of [['agent-explore', 'explore-facts'], ['agent-advisor', 'consult-advisor']]) {
    const packages = [...runtime.packageRoots].filter(([id]) => id.startsWith(`${plugin}@`));
    expect(packages).toHaveLength(1);
    const [, packageRoot] = packages[0]!;
    expect(await fs.readdir(path.join(packageRoot, 'skills'))).toEqual([skill]);
    expect(await fs.pathExists(path.join(packageRoot, 'skills', skill, 'SKILL.md'))).toBe(true);
  }
  const commandList = await run<{ packages: Array<{ selector: string; availability: string }> }>(['command', 'list']);
  expect(commandList.packages).toEqual([expect.objectContaining({ selector: guide, availability: 'ready' })]);

  // A static override makes this a deterministic test of the actual provider
  // and its protocol, while never invoking a model or probing a real backend.
  const registry = [{
    key: 'external-fixture', adapter: 'codex', modelsPolicy: 'override',
    models: [{ id: 'fixture-model', efforts: ['high'], defaultEffort: 'high', default: true }],
  }];
  await run(set(guide, 'subagentCommands', registry));
  const selected = { executor: 'external-fixture' };
  await run(set(explorer, 'exploreProfile', selected, 'codex'));
  await run(set(advisor, 'advisorProfile', selected, 'codex'));
  await run(set(advisor, 'advisorProfile', selected, 'claude'));
  for (const [pluginId, field, hint] of [
    [explorer, 'exploreProfile', 'fast'], [explorer, 'deepExploreProfile', 'strong'],
    [advisor, 'advisorProfile', 'strong'], [advisor, 'deepAdvisorProfile', 'deep'],
  ]) {
    const object = await run([...config, 'suggestions', pluginId, field, '--platform', 'codex', '--dep', 'executor=external-fixture']);
    expect(object).toMatchObject({
      kind: 'object', provider: 'executor-model-profile', providerPluginId: guide, status: 'ok',
      items: expect.arrayContaining([expect.objectContaining({
        set: { model: 'fixture-model' }, children: expect.objectContaining({ items: expect.arrayContaining([expect.objectContaining({
          set: { reasoningEffort: 'high' }, recommendedHints: expect.arrayContaining([hint]), recommended: true,
        })]) }),
      })]),
    });
  }
  for (const [pluginId, field] of [[explorer, 'exploreProfile'], [advisor, 'advisorProfile']]) {
    // No --dep override: the scalar query has to read the consumer's selection
    // and resolve it against the actual Guide registry.
    const scalar = await run([...config, 'suggestions', pluginId, `${field}.model`, '--platform', 'codex']);
    expect(scalar).toMatchObject({
      kind: 'scalar', provider: 'executor-models', providerPluginId: guide, status: 'ok',
      items: [expect.objectContaining({ value: 'fixture-model', source: 'configured' })],
    });
  }

  await run(['target', 'set', 'codex', '--context', 'user']);
  const removeRegistry = set(guide, 'subagentCommands', []);
  const blocked = await invoke(removeRegistry);
  expect(blocked.exitCode).not.toBe(0);
  expect(blocked.stdout).toContain('external-fixture');
  for (const [pluginId, field] of [[explorer, 'exploreProfile'], [advisor, 'advisorProfile']]) {
    await run([...config, 'unset', pluginId, field, '--context', 'user', '--platform', 'codex']);
  }
  // A saved but inactive Claude selection remains readable and cannot veto
  // the common provider registry change.
  await run(removeRegistry);
  const historical = await run([...config, 'get', advisor, 'advisorProfile', '--context', 'user', '--platform', 'claude']);
  expect(historical).toMatchObject({
    fields: [expect.objectContaining({ key: 'advisorProfile', storedValue: selected })],
  });
}, 120_000);
