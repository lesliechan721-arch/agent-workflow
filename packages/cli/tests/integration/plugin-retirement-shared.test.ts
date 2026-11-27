import path from 'node:path';
import fs from 'fs-extra';
import { expect, it, vi } from 'vitest';
import { type LifecycleData } from '../../src/commands/public-lifecycle-result.js';
import { type CommandResult } from '../../src/output/public-result.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { readCodexConfigFile, removeCodexMarketplace } from '../../src/utils/codex-config.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import type { PluginMeta } from '../../src/types.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { getNativeTestLayout, installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { createCodexNativeTestRuntime, createNativeDependencyCatalog, replaceCatalogSourcesConfig, snapshotRegularTree } from '../helpers/write-command-fixture.js';
import { getCurrentSourceTestIsolation, registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';

// Copilot exposes local marketplace entries as live even before an install and
// after an uninstall. Re-read its current manifest and settings on every list.
function createCopilotRuntime(env: NodeJS.ProcessEnv, cwd: string) {
  const userSettings = path.join(resolvePlatformConfigRoot('copilot', { cwd, env }), 'settings.json');
  let market: { root: string; name: string } | undefined;
  const installed = new Set<string>();
  const manifest = async () => fs.readJson(path.join(market!.root, '.github', 'plugin', 'marketplace.json'));
  let failUninstall = false;
  let marketplaceRegistered = true;
  const nativeCliRunner = vi.fn(async ({ args, cwd: observedCwd }: NativeCliInvocation) => {
    let value: unknown = [];
    if (args.includes('--version')) return { exitCode: 0, stdout: '1.0.95', stderr: '' };
    if (args.join(' ') === 'plugin marketplace list --json') {
      value = market && marketplaceRegistered ? [{ name: market.name, source: `Local: ${market.root}` }] : [];
    } else if (args.join(' ') === 'plugin list --json') {
      if (market) {
        const user = await fs.readJson(userSettings).catch(() => ({}));
        const project = await fs.readJson(path.join(observedCwd ?? cwd, '.github', 'copilot', 'settings.local.json')).catch(() => ({}));
        value = (await manifest()).plugins.map((entry: { name: string; version: string }) => {
          const id = `${entry.name}@${market!.name}`;
          return { name: entry.name, version: entry.version, marketplace: market!.name,
            source: 'live', installedFrom: market!.root,
            enabled: (project.enabledPlugins?.[id] ?? user.enabledPlugins?.[id]) === true };
        });
      }
    } else if (args.slice(0, 3).join(' ') === 'plugin marketplace add') {
      const root = args[3]!;
      market = { root, name: (await fs.readJson(path.join(root, '.github', 'plugin', 'marketplace.json'))).name };
    } else if (args.slice(0, 2).join(' ') === 'plugin install') {
      installed.add(args[2]!);
    } else if (args.slice(0, 2).join(' ') === 'plugin uninstall') {
      // The native uninstall must run while the manifest and package still exist.
      const id = args[2]!;
      const name = id.split('@')[0]!;
      expect(installed.has(id)).toBe(true);
      expect((await manifest()).plugins).toContainEqual(expect.objectContaining({ name }));
      expect(await fs.pathExists(path.join(market!.root, 'plugins', name))).toBe(true);
      if (failUninstall) return { exitCode: 1, stdout: '', stderr: 'Simulated Copilot uninstall failure.' };
      installed.delete(id);
    } else throw new Error(`Unexpected controlled Copilot request: ${args.join(' ')}`);
    return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
  });
  return { nativeCliRunner, installed, failUninstall: (value: boolean) => { failUninstall = value; },
    marketplaceRegistered: (value: boolean) => { marketplaceRegistered = value; } };
}

const hostPaths = {
  codex: ['.codex', 'config.toml'],
  claude: ['.claude', 'settings.local.json'],
  copilot: ['.github', 'copilot', 'settings.local.json'],
} as const;
const marketplaceManifests = {
  codex: ['.agents', 'plugins', 'marketplace.json'],
  claude: ['.claude-plugin', 'marketplace.json'],
  copilot: ['.github', 'plugin', 'marketplace.json'],
} as const;

// Test Value Gate: crossing real public remove boundaries is necessary to
// prove the first retirement doesn't change another project's declaration or
// host config, and that the second command can rediscover a now-absent package.
it.each(['codex', 'claude', 'copilot'] as const)(
  'retires a shared %s package from Project A, then cleans the unmodified Project B without a package',
  async (platform) => {
    const isolation = getCurrentSourceTestIsolation();
    const { env, layout } = isolation;
    installNativeTestDiscovery({ platforms: [platform],
      ...(platform === 'copilot' ? { executable: process.execPath } : {}) });
    const projectA = layout.fixtureCwd;
    const projectB = path.join(layout.rootDir, 'project-b');
    registerCurrentTestWritableStateRoot(projectB, 'secondary project for retirement');
    for (const cwd of [projectA, projectB]) await fs.ensureDir(path.join(cwd, '.git'));
    const codex = platform === 'codex' ? await createCodexNativeTestRuntime(isolation) : undefined;
    const claude = platform === 'claude' ? await createClaudeNativeTestRuntime(isolation) : undefined;
    const copilot = platform === 'copilot' ? createCopilotRuntime(env, projectA) : undefined;
    const nativeCliRunner = (codex ?? claude ?? copilot)!.nativeCliRunner;
    if (codex) {
      const runner = codex.nativeCliRunner.getMockImplementation()!;
      codex.nativeCliRunner.mockImplementation(async (invocation) => {
        const response = await runner(invocation);
        if (invocation.args.includes('list') && invocation.args.includes('--json') && invocation.cwd) {
          const project = await readCodexConfigFile(path.join(invocation.cwd, '.codex', 'config.toml'));
          const user = await readCodexConfigFile(path.join(env.CODEX_HOME!, 'config.toml'));
          const value = JSON.parse(response.stdout);
          value.installed = value.installed.map((row: { pluginId: string }) => ({ ...row,
            enabled: project.snapshot.plugins[row.pluginId]?.enabled ?? user.snapshot.plugins[row.pluginId]?.enabled ?? false,
          }));
          return { ...response, stdout: JSON.stringify(value) };
        }
        return response;
      });
    }
    const sourceRoot = path.join(layout.rootDir, 'catalog');
    registerCurrentTestWritableStateRoot(sourceRoot, 'catalog fixture');
    const definitions = ['demo', 'other'].map((name) => ({
      name, configureManifest(manifest: PluginMeta['manifest']) {
        manifest.platforms = [platform];
        if (platform === 'copilot') delete manifest.skills;
        manifest.extensions = { agents: [{ name: `${name}-role`, description: 'Fixture role.', prompt: 'Review changes.' }] };
      },
    }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const before = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: before.digest, env });
    await setTargets({ cwd: projectA, env, scope: 'user' }, [platform]);

    const run = async (cwd: string, ...args: string[]) => {
      const result = await runCliEntry(['plugin', ...args, '--json'], { cwd, env, nativeCliRunner, interactive: false });
      const receipt = result.parseJsonStdout<CommandResult<LifecycleData>>();
      expect(receipt.schemaVersion).toBe(2);
      expect(result.stdout.trim().split(/\r?\n/u)).toHaveLength(1);
      return { result, receipt };
    };
    for (const [scope, cwd, plugins] of [
      ['project', projectA, ['team/demo']],
      ['project', projectB, ['team/demo']],
      ['user', projectA, ['team/demo', 'team/other']],
    ] as const) {
      const { result } = await run(cwd, 'install', ...plugins, '--scope', scope, '--context', scope, '--target', platform, '--yes');
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    }

    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env });
    const deployment = await getNativeTestLayout({ cwd: projectA, env, pluginId: 'team/demo',
      platform, scope: 'project', sourceIdentity: active.sourceIdentity });
    const id = deployment.nativeIdentity.registrationId!;
    const manifestPath = path.join(deployment.marketplaceRoot!, ...marketplaceManifests[platform]);
    const sibling = (await fs.readJson(manifestPath)).plugins.find((entry: { name: string }) => entry.name === 'other');
    expect(sibling).toBeDefined();
    const userIntent = await observeIntent({ cwd: projectA, env, scope: 'user' });
    const projectBIntent = await observeIntent({ cwd: projectB, env, scope: 'project' });
    const projectBConfig = path.join(projectB, ...hostPaths[platform]);
    const projectBBytes = await fs.readFile(projectBConfig);
    const projectBTree = await snapshotRegularTree(projectB);

    await createNativeDependencyCatalog(sourceRoot, [definitions[1]!]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env, impactConfirmed: true });
    const removeArgs = ['remove', 'team/demo', '--scope', 'project', '--context', 'project'];
    const review = await run(projectA, ...removeArgs);
    expect(review.result.exitCode, review.result.stdout + review.result.stderr).toBe(3);
    expect(review.receipt).toMatchObject({
      status: 'blocked', diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]),
      data: { confirmation: { required: true, provided: false, effects: expect.arrayContaining([
        expect.objectContaining({ impact: 'shared', subject: expect.objectContaining({ pluginId: 'team/demo', scope: 'project' }),
          message: expect.stringMatching(/shared.*(?:package|registration)/iu) }),
      ]) } },
    });
    const sharedEffect = (review.receipt.data as LifecycleData).confirmation!.effects.find((effect) => effect.impact === 'shared')!;
    expect(sharedEffect.message).toMatch(/other projects/iu);
    expect(sharedEffect.message).toMatch(/(?:retain|remain|preserv|keep)/iu);
    expect(sharedEffect.message).not.toMatch(/[\u3400-\u9fff]/u);
    expect(await fs.pathExists(deployment.packageRoot)).toBe(true);

    if (copilot) {
      const manifestBefore = await fs.readFile(manifestPath);
      copilot.failUninstall(true);
      const failed = await run(projectA, ...removeArgs, '--yes');
      expect(failed.receipt.status, failed.result.stdout).not.toBe('success');
      expect(failed.receipt.nextActions).toContainEqual(expect.objectContaining({ kind: 'command',
        argv: ['aw', 'plugin', 'remove', 'team/demo', '--scope', 'project'], requiresConfirmation: true }));
      expect(await fs.pathExists(deployment.packageRoot)).toBe(true);
      expect(await fs.readFile(manifestPath)).toEqual(manifestBefore);
      copilot.failUninstall(false);
    }

    nativeCliRunner.mockClear();
    const retired = await run(projectA, ...removeArgs, '--yes');
    expect(retired.result.exitCode, retired.result.stdout + retired.result.stderr).toBe(0);
    expect(retired.receipt).toMatchObject({ status: 'success', data: {
      remainingTargets: [], targetResults: expect.arrayContaining([expect.objectContaining({
        pluginId: 'team/demo', target: platform, scope: 'project',
        deploymentReceipts: expect.arrayContaining([expect.objectContaining({ after: expect.objectContaining({
          package: 'absent', registration: 'absent',
        }) })]),
      })]),
    } });
    expect(await fs.pathExists(deployment.packageRoot)).toBe(false);
    expect((await fs.readJson(manifestPath)).plugins).toContainEqual(sibling);
    expect((await fs.readJson(manifestPath)).plugins.some((entry: { name: string }) => entry.name === 'demo')).toBe(false);
    expect(await fs.pathExists(path.join(deployment.marketplaceRoot!, 'plugins', 'other'))).toBe(true);
    expect(await observeIntent({ cwd: projectA, env, scope: 'user' })).toEqual(userIntent);
    expect(await observeIntent({ cwd: projectB, env, scope: 'project' })).toEqual(projectBIntent);
    expect(await fs.readFile(projectBConfig)).toEqual(projectBBytes);
    expect(await snapshotRegularTree(projectB)).toEqual(projectBTree);
    if (claude) {
      const uninstalls = nativeCliRunner.mock.calls.map(([invocation]) => invocation.args)
        .filter((args) => args.includes('uninstall') && args.includes(id))
        .map((args) => args[args.indexOf('--scope') + 1]);
      expect(uninstalls).toEqual(['local', 'user']);
      expect((await fs.readJson(claude.installedPath)).plugins[id]).toEqual([
        expect.objectContaining({ scope: 'local', projectPath: await fs.realpath(projectB) }),
      ]);
    } else if (codex) {
      expect(codex.installed.has(id)).toBe(false);
      expect((await readCodexConfigFile(path.join(projectA, ...hostPaths.codex))).snapshot.plugins[id]).toBeUndefined();
    } else {
      expect(copilot!.installed.has(id)).toBe(false);
      for (const file of [path.join(projectA, ...hostPaths.copilot),
        path.join(resolvePlatformConfigRoot('copilot', { cwd: projectA, env }), 'settings.json')]) {
        expect((await fs.readJson(file)).enabledPlugins?.[id]).toBeUndefined();
      }
    }

    // Missing package ownership is never sufficient evidence. The public
    // command must preserve B's activation or its local registration when
    // current canonical marketplace proof is missing, even after a valid
    // retirement removed the shared package.
    let restoreProof: () => Promise<void>;
    if (codex) {
      const file = path.join(env.CODEX_HOME!, 'config.toml');
      const original = await fs.readFile(file, 'utf8');
      await fs.outputFile(file, removeCodexMarketplace(original, deployment.marketplaceName!));
      restoreProof = async () => fs.outputFile(file, original);
    } else if (claude) {
      const file = path.join(deployment.marketplaceRoot!, 'config.json');
      const original = await fs.readFile(file);
      await fs.remove(file);
      restoreProof = async () => fs.outputFile(file, original);
    } else {
      copilot!.marketplaceRegistered(false);
      restoreProof = async () => { copilot!.marketplaceRegistered(true); };
    }
    nativeCliRunner.mockClear();
    try {
      const blocked = await run(projectB, ...removeArgs, '--yes');
      expect(blocked.receipt.status, blocked.result.stdout).not.toBe('success');
      expect(await fs.readFile(projectBConfig)).toEqual(projectBBytes);
      expect(nativeCliRunner.mock.calls.some(([invocation]) =>
        invocation.args.includes(id) && (invocation.args.includes('uninstall') || invocation.args.includes('remove')))).toBe(false);
      if (claude) expect((await fs.readJson(claude.installedPath)).plugins[id]).toEqual([
        expect.objectContaining({ scope: 'local', projectPath: await fs.realpath(projectB) }),
      ]);
      expect(await fs.pathExists(deployment.packageRoot)).toBe(false);
    } finally {
      await restoreProof();
    }

    nativeCliRunner.mockClear();
    const finished = await run(projectB, ...removeArgs, '--yes');
    expect(finished.result.exitCode, finished.result.stdout + finished.result.stderr).toBe(0);
    expect(finished.receipt).toMatchObject({ status: 'success', data: { remainingTargets: [], changes: { outputs: 'changed' } } });
    expect(await observeIntent({ cwd: projectB, env, scope: 'project' })).toMatchObject({ state: 'valid', value: { roots: [] } });
    expect(await observeIntent({ cwd: projectA, env, scope: 'user' })).toEqual(userIntent);
    if (claude) {
      expect((await fs.readJson(claude.installedPath)).plugins[id]).toBeUndefined();
      expect(nativeCliRunner.mock.calls.map(([invocation]) => invocation.args)
        .filter((args) => args.includes('uninstall') && args.includes(id))
        .map((args) => args[args.indexOf('--scope') + 1])).toEqual(['local']);
    } else if (codex) {
      expect((await readCodexConfigFile(projectBConfig)).snapshot.plugins[id]).toBeUndefined();
      expect(await fs.pathExists(path.join(projectB, '.codex', 'agents', 'aw-team-demo-demo-role.toml'))).toBe(false);
    } else {
      expect((await fs.readJson(projectBConfig)).enabledPlugins?.[id]).toBeUndefined();
    }
    const status = await run(projectB, 'status', '--context', 'project');
    // The intentionally retained User declaration still needs its own retirement;
    // only that missing catalog demand may remain, not another Project deployment.
    expect(status.result.exitCode, status.result.stdout + status.result.stderr).toBe(4);
    expect(status.receipt.data).toMatchObject({
      inventory: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/demo',
        targetResults: [expect.objectContaining({ scope: 'user', blockerCodes: ['pluginUnavailable'] })],
      })]),
      extraObserved: expect.not.arrayContaining([expect.objectContaining({ pluginId: 'team/demo', scope: 'project' })]),
    });
  }, 60_000,
);
