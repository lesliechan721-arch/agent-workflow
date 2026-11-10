import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { executeRecovery, executeRecoveryPreApply, prepareRecovery } from '../../src/recovery/coordinator.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { applyPluginConfig, preparePluginConfigApply, disposePluginConfigApply } from '../../src/utils/plugin-config-write.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { PlatformRebuildSession } from '../../src/commands/rebuild-platform-integration.js';
import { getAgentPluginAdapter } from '../../src/platforms/registry.js';
import { getDeploymentLayout } from '../../src/platforms/layout.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { effectsForPlan } from '../../src/commands/public-lifecycle.js';

const targets = ['antigravity', 'cursor', 'opencode', 'pi', 'generic'] as const;
type FixtureTarget = (typeof targets)[number];
const sessions: PlatformRebuildSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

async function fixture(platforms: FixtureTarget[], dependency = false, options: { trustedPi?: boolean } = {}) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const env = isolation.env;
  await git(cwd, ['init', '--quiet']);
  const piAgentRoot = resolvePlatformConfigRoot('pi', { cwd, env });
  if (platforms.includes('pi') && options.trustedPi !== false) {
    await fs.outputJson(path.join(piAgentRoot, 'trust.json'), { [await fs.realpath(cwd)]: true });
  }
  const sourceRoot = path.join(cwd, 'catalog');
  const trace = path.join(cwd, 'pre-apply.jsonl');
  const fail = path.join(cwd, 'fail-cursor');
  const names = dependency ? ['provider', 'consumer', 'independent'] : ['demo'];
  const bin = path.join(cwd, 'native-bin');
  const versions = { agy: 'Antigravity 1.3.4', 'cursor-agent': 'Cursor Agent 2026.11.05-86047df',
    opencode: 'opencode 2.0.0', pi: 'Pi coding agent 1.5.0' };
  for (const name of Object.keys(versions)) await fs.outputFile(path.join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`), '', { mode: 0o755 });
  env.PATH = [bin, path.dirname(process.execPath), ...(process.platform === 'win32'
    ? [path.join(env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter);
  const nativeCliRunner = async (call: NativeCliInvocation) => {
    if (call.args.includes('--version')) return { exitCode: 0, stdout: versions[path.basename(call.command).replace(/\.exe$/u, '') as keyof typeof versions] ?? '', stderr: '' };
    if (path.basename(call.command).replace(/\.exe$/u, '') !== 'pi' || !['install', 'remove'].includes(call.args[0]!)) throw new Error('Unexpected fixture native mutation.');
    const source = call.args.filter((arg) => !arg.startsWith('--')).at(-1)!;
    const settingsPath = call.args.includes('--local') ? path.join(call.cwd, '.pi/settings.json') : path.join(piAgentRoot, 'settings.json');
    const settings = await fs.readJson(settingsPath).catch(() => ({}));
    const packages = (settings.packages ?? []).filter((entry: string) => entry !== source);
    if (call.args[0] === 'install') packages.push(source);
    await fs.outputJson(settingsPath, { ...settings, packages });
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const runtime = () => {
    const context = { ...createCommandExecutionContext({ env, nativeCliRunner }), platformRebuildSession: undefined as PlatformRebuildSession | undefined };
    // Synthetic qualification only; use the real discovery, package projection and lifecycle.
    context.platformRebuildSession = new PlatformRebuildSession(context, (platform) => {
      const adapter = getAgentPluginAdapter(platform);
      return { ...adapter, capabilities: (input) => adapter.capabilities({ ...input, profile: { ...input.profile,
        kinds: { ...input.profile.kinds, skill: { ...input.profile.kinds.skill, status: 'supported', reasonCodes: [] } } } }) };
    });
    sessions.push(context.platformRebuildSession);
    return context;
  };
  for (const name of names) {
    const root = path.join(sourceRoot, 'plugins', name);
    await fs.outputFile(path.join(root, 'scripts/pre-apply.mjs'), [
      "import fs from 'node:fs';",
      'const context=JSON.parse(fs.readFileSync(0,"utf8"));',
      `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(context)+"\\n");`,
      `if(fs.existsSync(${JSON.stringify(fail)})&&context.target.platform==='cursor'&&context.plugin.name!=="consumer"&&context.plugin.name!=="independent")process.exit(23);`,
    ].join('\n'));
    await fs.outputFile(path.join(root, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: PreApply hook fixture.\n---\nUse ${name}.\n`);
    await fs.outputFile(path.join(root, 'skills', name, 'README.md'), `Use ${name}.\n`);
  }
  await createDependencyCatalogSnapshotFixture(sourceRoot, names.map((name) => ({ name,
    ...(name === 'consumer' ? { dependencies: ['provider'] } : {}),
    configureManifest: (manifest) => {
      manifest.platforms = platforms;
      manifest.skills = './skills';
      delete manifest.extensions;
      manifest.scripts = { preApply: { path: './scripts/pre-apply.mjs' } };
      manifest.config = { schemaVersion: 5, fields: { value: { type: 'number', default: 7 } },
        platforms: Object.fromEntries(platforms.map((platform) => [platform, {
          fields: { value: { type: 'string', default: `default-${platform}` } },
        }])) };
    },
  })));
  const entries = [];
  for (const name of names) {
    const root = path.join(sourceRoot, 'plugins', name);
    const plugin = await readPluginManifest(root, { mode: 'bundle' });
    for (const platform of platforms) await fs.outputJson(path.join(root, platform, 'skills', name, 'aw-plugin-requirements.json'),
      createAwPluginRequirementsReceipt({ name, version: '1.0.0' }, plugin.manifest.requires?.aw.capabilities ?? []));
    entries.push(await createCatalogManifestV7Entry(plugin, root));
  }
  const catalogPath = path.join(sourceRoot, 'catalog-manifest.json');
  await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries: entries.sort((left, right) => left.name.localeCompare(right.name)) });
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ env, expectedDigest: snapshot.digest,
    config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] } });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  const operation = await resolveCatalogOperationContext({ sourceIds: ['team'], env });
  const source = operation.catalog.sources[0]!.resolution!;
  const plugin = { ...await readPluginManifest(path.join(source.rootDir, 'plugins', names[0]!), { mode: 'bundle' }),
    sourceId: 'team', sourceIdentity: source.sourceIdentity, catalogLogicalIdentity: source.logicalIdentity,
    pluginId: `team/${names[0]}` };
  const store = { sourceId: 'team', sourceIdentity: source.sourceIdentity, logicalIdentity: source.logicalIdentity,
    pluginName: names[0]!, scope: 'user' as const, cwd, env };
  await setTargets({ cwd, env, scope: 'user' }, platforms);
  const run = async (args: string[]) => {
    const io = createCapturedCliIo();
    const context = { ...runtime(), cwd, interactive: false, io: io.io };
    const exitCode = await runCli(['plugin', ...args, '--json'], context);
    return { exitCode, value: JSON.parse(io.readStdout()) };
  };
  const outputs = new Map<string, string>();
  for (const platform of platforms) for (const name of names) {
    const adapter = getAgentPluginAdapter(platform);
    const ctx = { cwd, env, runner: nativeCliRunner };
    const identity = { sourceId: 'team', sourceIdentity: source.sourceIdentity, pluginId: `team/${name}`, version: '1.0.0' };
    const resolved = await adapter.resolve(ctx, { plugin: identity, scope: { kind: 'project', projectRoot: cwd }, operation: 'ensure',
      discovery: await adapter.discover(ctx), recoveryCandidates: [] });
    expect(resolved.bindings, JSON.stringify(resolved)).toHaveLength(1);
    const layout = await getDeploymentLayout(ctx, resolved.bindings[0]!);
    outputs.set(`${platform}/${name}`, platform === 'generic' ? path.join(layout.packageRoot, name)
      : path.join(layout.packageRoot, 'skills', name));
  }
  const output = (platform: FixtureTarget, name = names[0]!) => outputs.get(`${platform}/${name}`)!;
  const events = async () => await fs.pathExists(trace)
    ? (await fs.readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { cwd, env, piAgentRoot, trace, fail, plugin, store, run, output, events, runtime };
}

describe('Native and generic preApply execution', () => {
  // Test Value Gate: each target must use its compiled profile, require explicit script authorization,
  // and run the real process once after Review without allowing status to repeat it.
  it.each(targets)('authorizes %s and runs its actual platform profile once', async (platform) => {
    const f = await fixture([platform]);
    await writePluginConfigStore({ ...f.store, values: { value: 7 } });
    await writePluginConfigStore({ ...f.store, platform, values: { value: `stored-${platform}` } });
    const rejected = await f.run(['install', 'team/demo', '--scope', 'project']);
    expect(rejected.exitCode).toBe(3);
    expect(rejected.value, JSON.stringify(rejected.value)).toMatchObject({ command: 'plugin.install', status: 'blocked', data: {
      confirmation: { required: true, provided: false, effects: [expect.objectContaining({ code: 'runPreApply' })] },
      changes: { requirements: 'none', outputs: 'none' },
    }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]) });
    expect(await fs.pathExists(f.output(platform))).toBe(false);
    expect(await f.events()).toEqual([]);
    const preparedRuntime = f.runtime();
    const plan = await prepareRecovery('install', ['team/demo'], {
      scope: 'project', cwd: f.cwd, env: f.env, context: 'project', cliVersion: '1.0.0', targets: [platform],
    }, preparedRuntime);
    expect(effectsForPlan(plan)).toContainEqual(expect.objectContaining({ code: 'runPreApply',
      subject: { pluginId: 'team/demo', target: platform, scope: 'project' } }));
    expect(await f.events()).toEqual([]);
    const applied = await withAwHomeMutationLock({ env: f.env, action: async (token) => {
      const runtime = { ...preparedRuntime, awHomeMutationToken: token, preApplyConfirmed: true,
        preApplyExecutionCache: new Map<string, Promise<void>>() };
      const child = plan.joint!.children.find((entry) => entry.options.scope === 'project')!;
      expect(await executeRecoveryPreApply(child, 'team/demo', platform, runtime)).toBeUndefined();
      expect(await fs.pathExists(f.output(platform))).toBe(false);
      expect(await f.events()).toHaveLength(1);
      return executeRecovery(plan, { yes: true, runtime });
    } });
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    expect(await fs.pathExists(f.output(platform))).toBe(true);
    expect(await f.events()).toEqual([expect.objectContaining({
      target: { platform, scope: 'project', projectRoot: f.cwd }, config: { values: { value: `stored-${platform}` } },
    })]);
    const status = await f.run(['status', '--context', 'project']);
    const qualifiedPi = platform === 'pi' && process.platform === 'darwin' && process.arch === 'arm64';
    if (platform === 'generic' || qualifiedPi) {
      expect(status.exitCode, JSON.stringify(status.value)).toBe(0);
      if (qualifiedPi) {
        expect(status.value.data.allSatisfied).toBe(true);
        expect(status.value.data.inventory).toContainEqual(expect.objectContaining({
          targetResults: expect.arrayContaining([expect.objectContaining({ target: 'pi',
            deploymentObservations: expect.arrayContaining([expect.objectContaining({ after: expect.objectContaining({
              consumers: expect.arrayContaining([expect.objectContaining({ trust: 'trusted', load: 'unknown' })]),
            }) })]),
          })]),
        }));
      }
    } else {
      // The operation-local Skill qualification does not invent global client
      // qualification, host trust or session loading for the read-only status command.
      expect([3, 4], JSON.stringify(status.value)).toContain(status.exitCode);
      expect(status.value).toMatchObject({ command: 'plugin.status', data: { context: 'project', counts: { ready: 0 } } });
      expect([false, null]).toContain(status.value.data.allSatisfied);
      expect([false, null]).toContain(status.value.data.inSync);
      expect(status.value.data.inventory).toContainEqual(expect.objectContaining({ pluginId: 'team/demo',
        targetResults: expect.arrayContaining([expect.objectContaining({ target: platform, scope: 'project',
          execution: 'not-run', deploymentObservations: expect.arrayContaining([expect.objectContaining({ after: expect.objectContaining({
            package: 'present', components: expect.arrayContaining([expect.objectContaining({ id: 'skill:demo', presence: 'present' })]),
            consumers: expect.arrayContaining([expect.objectContaining({ load: expect.stringMatching(/^(?:unknown|not-observed)$/u) })]),
          }) })]) })]) }));
      if (status.value.diagnostics.length) {
        expect(status.value.diagnostics).toContainEqual(expect.objectContaining({ code: 'capability-unverified' }));
      }
    }
    expect(await f.events()).toHaveLength(1);
  }, 30_000);

  // Pi 1.5 ignores all project settings before trust, including package Skills.
  // A failed trust postcheck must retain actual publication/registration and report the incomplete target.
  it('keeps an untrusted Pi install partial and reports the same policy in read-only status', async () => {
    const f = await fixture(['pi'], false, { trustedPi: false });
    const installed = await f.run(['install', 'team/demo', '--scope', 'project', '--yes']);
    expect(installed.exitCode, JSON.stringify(installed.value)).toBe(4);
    expect(installed.value.data.targetResults).toContainEqual(expect.objectContaining({ target: 'pi', execution: 'partial',
      deploymentReceipts: expect.arrayContaining([expect.objectContaining({
        effects: expect.arrayContaining([expect.objectContaining({ status: 'applied', mutation: 'confirmed' })]),
        after: expect.objectContaining({ package: 'present', registration: 'present',
          consumers: expect.arrayContaining([expect.objectContaining({ activation: 'blocked', trust: 'required', load: 'unknown' })]) }),
        unmet: expect.arrayContaining([expect.objectContaining({ componentId: 'skill:demo', reasonCode: 'nativeTrustRequired' })]),
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'nativeTrustRequired' })]),
      })]),
    }));
    const skill = await fs.readFile(path.join(f.output('pi'), 'SKILL.md'));
    expect(skill.toString()).toContain('Use demo.');
    expect((await fs.readJson(path.join(f.cwd, '.pi/settings.json'))).packages)
      .toContain(path.dirname(path.dirname(f.output('pi'))));
    expect(await fs.pathExists(path.join(f.piAgentRoot, 'trust.json'))).toBe(false);
    const status = await f.run(['status', '--context', 'project']);
    expect([3, 4], JSON.stringify(status.value)).toContain(status.exitCode);
    expect(status.value.data.allSatisfied).toBe(false);
    expect(status.value.data.counts.ready).toBe(0);
    expect(status.value.diagnostics).toContainEqual(expect.objectContaining({ code: 'nativeTrustRequired' }));
    expect(await fs.readFile(path.join(f.output('pi'), 'SKILL.md'))).toEqual(skill);
    expect(await f.events()).toHaveLength(1);
  }, 30_000);

  // Test Value Gate: a real exit 23 must prevent the provider and its consumer from publishing while
  // another platform and independent targets still complete; shared providers must not run twice.
  it('blocks failed Native providers and consumers while independent targets continue', async () => {
    const f = await fixture(['cursor', 'opencode'], true);
    await fs.outputFile(f.fail, 'fail cursor');
    const result = await f.run(['install', 'team/consumer', 'team/independent', '--scope', 'project', '--yes']);
    expect(result.exitCode).toBe(4);
    expect(result.value.data.allSatisfied).toBe(false);
    // The Native result wraps the script exit and blocks the dependent install.
    expect(result.value.data.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/provider', target: 'cursor', execution: 'failed',
        blockerCodes: expect.arrayContaining(['preApplyFailed']) }),
      expect.objectContaining({ pluginId: 'team/consumer', target: 'cursor', execution: 'not-run',
        blockerCodes: expect.arrayContaining(['dependencyInstallFailed']) }),
      expect.objectContaining({ pluginId: 'team/independent', target: 'cursor', execution: 'applied' }),
      expect.objectContaining({ pluginId: 'team/consumer', target: 'opencode', execution: 'applied' }),
    ]));
    expect(await fs.pathExists(f.output('cursor', 'provider'))).toBe(false);
    expect(await fs.pathExists(f.output('cursor', 'consumer'))).toBe(false);
    expect(await fs.pathExists(f.output('cursor', 'independent'))).toBe(true);
    expect(await fs.pathExists(f.output('opencode', 'consumer'))).toBe(true);
    const events = (await f.events()).map((event) => `${event.plugin.name}/${event.target.platform}`);
    expect(events.sort()).toEqual(['consumer/opencode', 'independent/cursor', 'independent/opencode', 'provider/cursor', 'provider/opencode']);
  }, 30_000);

  // Test Value Gate: independent config apply must Review the Native script and preserve an existing output
  // when the authorized script fails, without running a second save or losing its restore channel.
  it('reviews Native config apply authorization and preserves the installed output on script failure', async () => {
    const f = await fixture(['cursor']);
    const installed = await f.run(['install', 'team/demo', '--scope', 'project', '--yes']);
    expect(installed.exitCode, JSON.stringify(installed.value)).toBe(0);
    const file = path.join(f.output('cursor'), 'SKILL.md');
    const before = await fs.readFile(file);
    const options = { plugin: f.plugin, scope: 'user' as const, context: 'project' as const,
      platform: 'cursor' as const, cwd: f.cwd, env: f.env, cliVersion: '1.0.0' };
    const reviewed = await preparePluginConfigApply({ ...options, rebuildRuntime: f.runtime() });
    expect(reviewed.preApplyAuthorization, JSON.stringify({ authorization: reviewed.preApplyAuthorization,
      plan: reviewed.plan?.receipt })).toContainEqual(expect.objectContaining({
      pluginId: 'team/demo', platform: 'cursor', scope: 'project',
    }));
    await disposePluginConfigApply(reviewed.plan);
    expect((await applyPluginConfig({ ...options, rebuildRuntime: f.runtime() })).apply.error?.code).toBe('preApplyAuthorizationRequired');
    expect(await f.events()).toHaveLength(1);
    await fs.outputFile(f.fail, 'fail cursor');
    const result = await applyPluginConfig({ ...options, rebuildRuntime: f.runtime(), preApplyConfirmed: true, sharedNativeApplyConfirmed: true });
    expect(result).toMatchObject({ configWrite: 'notStarted', overallState: 'partial' });
    // Native config apply wraps the real exit 23 with its stable preApply failure code.
    expect(result.apply.targetResults).toContainEqual(expect.objectContaining({ state: 'failed', errorCode: 'preApplyFailed' }));
    expect(await fs.readFile(file)).toEqual(before);
    expect(await f.events()).toHaveLength(2);
  }, 30_000);
});
