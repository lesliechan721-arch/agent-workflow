import path from 'node:path';
import fs from 'fs-extra';
import { expect, it } from 'vitest';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { prepareRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import type { DebugLogger } from '../../src/output/model.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { createNativeDependencyCatalog } from '../helpers/write-command-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { runCliEntry } from '../helpers/cli-entry.js';

async function claudeCatalog() {
  const isolation = getCurrentSourceTestIsolation();
  const claude = await createClaudeNativeTestRuntime(isolation);
  const cwd = isolation.layout.fixtureCwd;
  const env = { ...isolation.env, PATH: claude.binRoot };
  const source = path.join(cwd, 'joint-native-source');
  await createNativeDependencyCatalog(source, [{ name: 'first', configureManifest: (manifest) => { manifest.platforms = ['claude']; } }]);
  const config = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
    sources: [{ id: 'team', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  const options = { cwd, env, context: 'user' as const, scope: 'user' as const, cliVersion: '1.0.0', yes: true };
  await setTargets(options, ['claude']);
  return { claude, options };
}

it.each(['command failure', '4097 marketplace records'] as const)('preserves the verified Claude install after %s in its final marketplace query', async (scenario) => {
  const { claude, options } = await claudeCatalog();
  let finalRead = false;
  const result = await runCliEntry(['plugin', 'install', 'team/first', '--scope', 'user', '--context', 'user', '--target', 'claude', '--yes', '--json'], {
    ...options, debugLogger: { log(event) {
      if (event.data?.name === 'recovery.status' && event.data.phase === 'start') finalRead = true;
    } },
    nativeCliRunner: async (request) => {
      if (!finalRead || !claude.isClaudeInvocation(request) || request.args.slice(-4).join(' ') !== 'plugin marketplace list --json') {
        return claude.nativeCliRunner(request);
      }
      if (scenario === 'command failure') return { exitCode: 1, stdout: '', stderr: 'controlled failure' };
      const root = path.parse(options.cwd).root;
      const rows = Array.from({ length: 4097 }, (_, index) =>
        ({ name: `marketplace-${index}`, source: 'directory', path: path.join(root, String(index)) }));
      return { exitCode: 0, stdout: JSON.stringify(rows), stderr: '' };
    },
  });
  expect(result.exitCode).toBe(4);
  expect(result.parseJsonStdout()).toMatchObject({ status: 'partial', data: { remainingTargets: [],
    changes: { requirements: 'changed', outputs: 'changed' },
    targetResults: [expect.objectContaining({ pluginId: 'team/first', target: 'claude', scope: 'user', observation: 'verified' })] },
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'statusUnavailable',
      detail: { reasonCode: 'nativeMarketplaceUnconfirmed' } })]),
    nextActions: [expect.objectContaining({ argv: ['aw', 'plugin', 'status', '--context', 'user', '--json'] })] });
});

// Test Value Gate: real joint Review must reject drift from its ordinary
// observations through the baseline and final independent checks.
it.each([
  'activation before baseline', 'activation after baseline', 'client version before baseline',
] as const)('shares ordinary Claude observations and detects %s within one joint preparation', async (change) => {
  const { claude, options } = await claudeCatalog();
  const selectors = ['team/first'];
  const installed = await runRecovery('install', selectors, options, claude.runtime);
  expect(installed, JSON.stringify(installed)).toMatchObject({ ok: true, targetResults: [{ execution: 'applied', content: 'satisfied' }] });
  const registrations = Object.entries((await fs.readJson(claude.installedPath)).plugins) as Array<[string, [{ installPath: string }]]>;
  const [pluginId, [registration]] = registrations[0]!;
  const skill = path.join(registration.installPath, 'skills', 'first-skill', 'SKILL.md');
  const skillBytes = await fs.readFile(skill, 'utf8');
  const installedBytes = await fs.readFile(claude.installedPath, 'utf8');

  claude.nativeCliRunner.mockClear();
  const invocations = (command: string) => claude.nativeCliRunner.mock.calls.flatMap(([request]) => {
    const args = request.args.slice(-command.split(' ').length).join(' ');
    return claude.isClaudeInvocation(request) && args === command ? [request] : [];
  });
  let inFirstBuild = false;
  let firstBuildFinished = false;
  let freshClientProbe = false;
  let activeVersion = '2.1.292 (Claude Code)';
  let disabled = false;
  let ordinaryReads: number[] | undefined;
  const buildInventories: Array<{ cwd: string; enabled: boolean }> = [];
  const debugLogger: DebugLogger = { log(event) {
    if (event.type !== 'performance:stage' || !event.data || !('name' in event.data)) return;
    if (event.data.name === 'dependency.plan' && !firstBuildFinished) {
      ordinaryReads = ['--version', 'plugin marketplace list --json', 'plugin list --json'].map((command) => invocations(command).length);
      inFirstBuild = true;
    }
    if (event.data.name === 'target.build') { firstBuildFinished = true; inFirstBuild = false; }
  } };
  const nativeCliRunner: NativeCliRunner = async (request) => {
    const output = await claude.nativeCliRunner(request);
    if (!claude.isClaudeInvocation(request)) return output;
    if (request.args.at(-1) === '--version') {
      if (inFirstBuild) {
        freshClientProbe = true;
        if (change === 'client version before baseline') activeVersion = '2.1.300 (Claude Code)';
      }
      return { ...output, stdout: activeVersion };
    }
    if (request.args.slice(-3).join(' ') !== 'plugin list --json') return output;
    const check = inFirstBuild && freshClientProbe;
    if (check && (change === 'activation before baseline' || change === 'activation after baseline' && buildInventories.length)) disabled = true;
    const entries = JSON.parse(output.stdout) as Array<{ id: string; enabled: boolean }>;
    const entry = entries.find((row) => row.id === pluginId)!;
    if (disabled) entry.enabled = false;
    if (check) buildInventories.push({ cwd: request.cwd!, enabled: entry.enabled });
    return { ...output, stdout: JSON.stringify(entries) };
  };
  const signal = new AbortController().signal;
  const plan = await prepareRecovery('install', selectors, { ...options, signal }, { nativeCliRunner, debugLogger });
  try {
    expect(ordinaryReads).toEqual([1, 1, 1]);
    expect(plan.receipt.targetResults[0]?.blockers.map(({ code }) => code)).toContain('operationPlanStale');
    expect(buildInventories.map(({ enabled }) => enabled)).toEqual(change === 'activation after baseline' ? [true, false]
      : change === 'activation before baseline' ? [false] : []);
    const inventories = invocations('plugin list --json').map(({ cwd }) => cwd!);
    expect(inventories.slice(1, 1 + buildInventories.length)).toEqual(buildInventories.map(({ cwd }) => cwd));
    expect(new Set(inventories.slice(0, 1 + buildInventories.length)).size).toBe(1 + buildInventories.length);
    expect(await Promise.all(inventories.map((directory) => fs.pathExists(directory)))).toEqual(inventories.map(() => false));
    expect(plan.receipt.outputsMayHaveChanged).toBe(false);
    expect(await fs.readFile(skill, 'utf8')).toBe(skillBytes);
    expect(await fs.readFile(claude.installedPath, 'utf8')).toBe(installedBytes);
  } finally {
    await plan.context.dispose();
  }
}, 30_000);
