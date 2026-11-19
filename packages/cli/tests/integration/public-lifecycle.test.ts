import path from 'node:path';
import os from 'node:os';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { defaultPluginProcessRunner } from '../../src/utils/plugin-scripts.js';
import { attachSafeOperationError } from '../../src/utils/safe-operation-diagnostic.js';
import { runCli } from '../../src/index.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { getNativeTestLayout, installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { runPublicLifecycle as executePublicLifecycle, type LifecycleData } from '../../src/commands/public-lifecycle.js';
import { runPublicPluginList, runPublicPluginShow, runPublicPluginStatus } from '../../src/commands/public-plugin-query.js';
import { createNativeDependencyCatalog, createCodexNativeTestRuntime } from '../helpers/write-command-fixture.js';
import { syncManagedCommandPackage, resolveManagedCommand } from '../../src/utils/managed-command-store.js';
import { normalizeCommandDefinition } from '@lesliechan721/aw-plugin-core/manifest';
import { NativeCliError, type NativeCliRunner } from '../../src/utils/native-cli.js';

// The real adapter publishes and inspects the package. The Pi command boundary
// reports registration only; it does not report activation, trust or loading.
const piRunner: NativeCliRunner = async (invocation) => {
  if (!['pi', 'pi.exe'].includes(path.basename(invocation.command).toLowerCase()) || !invocation.cwd) throw new Error('Unexpected Native test command.');
  const cwd = invocation.cwd;
  if (invocation.args[0] === 'list') {
    expect(invocation.args).toEqual(['list']);
    const user = resolvePlatformConfigRoot('pi', { cwd, env: invocation.env ?? getCurrentSourceTestIsolation().env });
    const sections: string[] = [];
    for (const [title, root] of [['User', user], ['Project', path.join(cwd, '.pi')]] as const) {
      const settings = await fs.readJson(path.join(root, 'settings.json')).catch(() => ({}));
      const packages: string[] = settings.packages ?? [];
      if (!packages.length) continue;
      const entries: string[] = [];
      for (const source of packages) {
        const installed = path.resolve(root, source);
        entries.push(`  ${source}`, ...(await fs.pathExists(installed) ? [`    ${installed}`] : []));
      }
      sections.push(`${title} packages:\n${entries.join('\n')}`);
    }
    return { exitCode: 0, stderr: '', stdout: sections.length ? `${sections.join('\n\n')}\n` : 'No packages installed.\n' };
  }
  if (!['install', 'remove'].includes(invocation.args[0]!) || !invocation.args.includes('--local')) throw new Error('Unexpected Native test command.');
  const file = path.join(cwd, '.pi', 'settings.json');
  const settings = await fs.readJson(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return {}; throw error;
  });
  const source = invocation.args.at(-1)!;
  const packages: string[] = settings.packages ?? [];
  await fs.outputJson(file, { ...settings, packages: invocation.args[0] === 'install'
    ? [...new Set([...packages, source])] : packages.filter((entry) => entry !== source) });
  return { exitCode: 0, stdout: '', stderr: '' };
};

async function runPublicLifecycle(...args: Parameters<typeof executePublicLifecycle>) {
  const [command, plugins, options, input] = args;
  return executePublicLifecycle(command, plugins, options, { ...input,
    nativeCliRunner: input?.nativeCliRunner ?? piRunner,
  });
}

async function fixture(options: { active?: boolean; script?: boolean | 'fail-pi'; targets?: string[]; sourceId?: string; name?: string; platforms?: Array<'generic' | 'pi' | 'claude'>; scriptBody?: string }={}) {
  const isolation=getCurrentSourceTestIsolation();
  const sourceId = options.sourceId ?? 'team';
  const name = options.name ?? 'demo';
  const cwd=path.join(isolation.layout.fixtureCwd, 'public-project');
  const source=path.join(isolation.layout.fixtureCwd, `public-source-${sourceId}`);
  await fs.ensureDir(cwd); await git(cwd, ['init', '--quiet']);
  const root=path.join(source, 'plugins', name);
  const platforms = options.platforms ?? ['generic', 'pi'];
  for(const folder of ['skills', ...platforms.map((platform) => `${platform}/skills`)]) {
    await fs.outputFile(path.join(root, folder, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Test ${name}\n---\nUse ${name}.\n`);
    await fs.outputFile(path.join(root, folder, name, 'README.md'), 'Use demo.\n');
  }
  if(options.script) await fs.outputFile(path.join(root, 'pre-apply.mjs'), "import fs from 'node:fs'; const input = JSON.parse(fs.readFileSync(0, 'utf8'));\n"
    + (options.scriptBody ?? '') + (options.script === 'fail-pi' ? "if (input.target.platform === 'pi') process.exit(7);\n" : ''));
  await createDependencyCatalogSnapshotFixture(source, [{
    name, configureManifest: (manifest) => {
      manifest.platforms=platforms; manifest.skills='./skills'; delete manifest.extensions;
      if(options.script) manifest.scripts={ preApply: { path: './pre-apply.mjs' } };
    }
  }]);
  const plugin=await readPluginManifest(root, { mode: 'bundle' });
  for(const target of platforms) await fs.outputJson(path.join(root, target, 'skills', name, 'aw-plugin-requirements.json'),
    createAwPluginRequirementsReceipt({ name, version: '1.0.0' }, plugin.manifest.requires?.aw.capabilities??[]));
  const catalog=path.join(source, 'catalog-manifest.json');
  await fs.writeJson(catalog, { ...await fs.readJson(catalog), entries: [await createCatalogManifestV7Entry(plugin, root)] });
  const current=await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: sourceId, type: 'path', primary: true, path: source }] }, expectedDigest: current.digest, env: isolation.env });
  if(options.active!==false) await syncCatalogSourceGeneration({ sourceId, cliVersion: '1.0.0', env: isolation.env });
  const location={ cwd, env: isolation.env, cliVersion: '1.0.0', scope: 'project' as const, context: 'project' as const };
  await setTargets(location, options.targets??['generic']);
  return { location, source, root, output: path.join(cwd, '.agents', 'skills', name) };
}

// Test Value Gate: protect public results and real writes at the confirmation, source, and ownership boundaries.
describe('public plugin lifecycle', () => {
  beforeEach(async () => {
    installNativeTestQualification({ discovery: true });
    const isolation = getCurrentSourceTestIsolation();
    await fs.outputJson(path.join(resolvePlatformConfigRoot('pi', { cwd: isolation.layout.fixtureCwd, env: isolation.env }), 'settings.json'), { packages: [], defaultProjectTrust: 'always' });
    const bin = path.join(isolation.layout.fixtureCwd, 'pi-controlled-bin');
    await fs.outputFile(path.join(bin, process.platform === 'win32' ? 'pi.exe' : 'pi'), 'controlled client entry');
    await fs.chmod(path.join(bin, process.platform === 'win32' ? 'pi.exe' : 'pi'), 0o755);
    isolation.env.PATH = `${bin}${path.delimiter}${isolation.env.PATH ?? ''}`;
  });
  it.each([
    { cores: 4, overlap: true }, { cores: 1, overlap: false },
  ])('runs each preApply alone and overlaps the independent Claude and Pi installs only with capacity (cores=$cores)', async ({ cores, overlap }) => {
    const isolation = getCurrentSourceTestIsolation();
    const claude = await createClaudeNativeTestRuntime(isolation);
    const events: string[] = [];
    const { location } = await fixture({ targets: ['claude', 'pi'], platforms: ['claude', 'pi'], script: true });
    const runScript = defaultPluginProcessRunner.run.bind(defaultPluginProcessRunner);
    const script = vi.spyOn(defaultPluginProcessRunner, 'run').mockImplementation(async (invocation, options) => {
      const host = JSON.parse(invocation.stdin!).target.platform;
      events.push('start-script-' + host);
      try { return await runScript(invocation, options); }
      finally { events.push('end-script-' + host); }
    });
    const activeInstalls = new Set<string>();
    const gate = Promise.withResolvers<void>();
    const parallelism = vi.spyOn(os, 'availableParallelism').mockReturnValue(cores);
    let timer: NodeJS.Timeout | undefined;

    const runner: NativeCliRunner = async (invocation) => {
      const pi = ['pi', 'pi.exe'].includes(path.basename(invocation.command).toLowerCase());
      const run = pi ? piRunner : claude.nativeCliRunner;
      const host = pi ? 'pi' : 'claude';
      const install = invocation.args.includes('install');
      const mutation = install || invocation.args.includes('add') || invocation.args.includes('enable');
      if (!mutation) return run(invocation);
      const kind = install ? 'install' : 'write';
      events.push('start-' + kind + '-' + host);
      try {
        if (install) {
          activeInstalls.add(host);
          if (activeInstalls.size === 2) { clearTimeout(timer); gate.resolve(); }
          else timer ??= setTimeout(() => { events.push('install-gate-expired'); gate.resolve(); }, 3000);
          await gate.promise;
        }
        return await run(invocation);
      } finally {
        if (install) activeInstalls.delete(host);
        events.push('end-' + kind + '-' + host);
      }
    };
    try {
      const result = await runPublicLifecycle('install', ['team/demo'], { ...location, yes: true }, { nativeCliRunner: runner });
      expect(result.status, JSON.stringify(result.diagnostics)).toBe('success');
      const claudeStart = events.indexOf('start-install-claude');
      const piStart = events.indexOf('start-install-pi');
      const claudeEnd = events.indexOf('end-install-claude');
      const piEnd = events.indexOf('end-install-pi');
      expect(Math.min(claudeStart, piStart, claudeEnd, piEnd), events.join(', ')).toBeGreaterThanOrEqual(0);
      expect(Math.max(claudeStart, piStart) < Math.min(claudeEnd, piEnd), events.join(', ')).toBe(overlap);
      expect(events.includes('install-gate-expired'), events.join(', ')).toBe(!overlap);
      let activeScripts = 0;
      let activeWrites = 0;
      const scripts: string[] = [];
      for (const event of events) {
        if (event === 'install-gate-expired') continue;
        const [phase, kind, host] = event.split('-');
        if (kind === 'script') {
          if (phase === 'start') scripts.push(host!);
          activeScripts += phase === 'start' ? 1 : -1;
        } else activeWrites += phase === 'start' ? 1 : -1;
        expect(activeScripts).toBeLessThanOrEqual(1);
        if (activeScripts) expect(activeWrites).toBe(0);
      }
      expect(scripts.sort()).toEqual(['claude', 'pi']);
      const status = await runPublicPluginStatus(['team/demo'], location, { nativeCliRunner: runner });
      expect(status.data).toMatchObject({ inventory: [expect.objectContaining({ targetResults: expect.arrayContaining([
        expect.objectContaining({ target: 'claude', content: 'satisfied' }), expect.objectContaining({ target: 'pi', content: 'satisfied' }),
      ]) })] });
    } finally { clearTimeout(timer); gate.resolve(); parallelism.mockRestore(); script.mockRestore(); }
  });

  it('rechecks the package after preApply writes there and finishes the other host', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const claude = await createClaudeNativeTestRuntime(isolation);
    const cwd = path.join(isolation.layout.fixtureCwd, 'public-project');
    await fs.ensureDir(cwd);
    const pi = await getNativeTestLayout({ platform: 'pi', pluginId: 'team/demo', scope: 'project', env: isolation.env, cwd });
    const foreignFile = path.join(pi.packageRoot, 'foreign.txt');
    const { location } = await fixture({ targets: ['claude', 'pi'], platforms: ['claude', 'pi'], script: true,
      scriptBody: `if (input.target.platform === 'pi') {
        fs.mkdirSync(${JSON.stringify(pi.packageRoot)}, { recursive: true });
        fs.writeFileSync(${JSON.stringify(foreignFile)}, 'from preApply');
      }` });
    const runner: NativeCliRunner = (invocation) => ['pi', 'pi.exe'].includes(path.basename(invocation.command).toLowerCase())
      ? piRunner(invocation) : claude.nativeCliRunner(invocation);
    const result = await runPublicLifecycle('install', ['team/demo'], { ...location, yes: true }, { nativeCliRunner: runner });
    expect(result.status, JSON.stringify(result.diagnostics)).toBe('partial');
    expect(result.data).toMatchObject({ targetResults: expect.arrayContaining([
      expect.objectContaining({ target: 'pi', execution: 'failed' }),
      expect.objectContaining({ target: 'claude', execution: 'applied', observation: 'verified', content: 'satisfied' }),
    ]) });
    expect(await fs.readFile(foreignFile, 'utf8')).toBe('from preApply');
    expect(await fs.readdir(pi.packageRoot)).toEqual(['foreign.txt']);
  });

  it.each([false, true])('stops the other host when its peer cannot clean up preApply (SIGINT %s)', async (interrupt) => {
    const isolation = getCurrentSourceTestIsolation();
    const claude = await createClaudeNativeTestRuntime(isolation);
    const { location } = await fixture({ targets: ['claude', 'pi'], platforms: ['claude', 'pi'], script: true });
    const controller = new AbortController();
    const interruption = { signal: controller.signal, exitCode: 130 as const, cleanupFailed: false };
    const scripts: string[] = [];
    const writes: string[] = [];
    const script = vi.spyOn(defaultPluginProcessRunner, 'run').mockImplementation(async (invocation) => {
      scripts.push(JSON.parse(invocation.stdin!).target.platform);
      if (interrupt) controller.abort(Object.assign(new Error('SIGINT'), { name: 'AbortError' }));
      throw attachSafeOperationError(new Error('Unconfirmed descendants'), { code: 'pluginProcessCleanupFailed',
        safeMessage: 'Plugin process cleanup could not be confirmed.' });
    });
    try {
      const result = await runPublicLifecycle('install', ['team/demo'], { ...location, yes: true }, {
        interruption, signal: controller.signal, nativeCliRunner: async (invocation) => {
          if (['add', 'install', 'enable'].some((command) => invocation.args.includes(command))) writes.push(invocation.command);
          return ['pi', 'pi.exe'].includes(path.basename(invocation.command).toLowerCase())
            ? piRunner(invocation) : claude.nativeCliRunner(invocation);
        },
      });
      expect(scripts).toHaveLength(1);
      expect(writes).toEqual([]);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'processCleanupUnconfirmed' }));
      expect(result.data).toMatchObject({ changes: { outputs: 'unknown' }, targetResults: expect.arrayContaining([
        expect.objectContaining({ target: scripts[0], execution: 'partial', content: 'unknown' }),
        expect.objectContaining({ target: scripts[0] === 'pi' ? 'claude' : 'pi', execution: 'not-run' }),
      ]) });
    } finally { script.mockRestore(); }
  });

  it('retains every producer result when removing Active and retired plugins together', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    await fs.ensureDir(path.join(cwd, '.git'));
    const source = path.join(cwd, 'mixed-remove-source');
    await createNativeDependencyCatalog(source, [{ name: 'active' }, { name: 'retired' }]);
    const config = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env: isolation.env });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const location = { cwd, env: isolation.env, cliVersion: '1.0.0', scope: 'user', context: 'user', yes: true };
    await setTargets({ ...location, scope: 'user' }, ['codex']);
    const installed = await runPublicLifecycle('install', ['team/active', 'team/retired'], location, runtime);
    expect(installed.status, JSON.stringify(installed)).toBe('success');
    const sourceIdentity = (await readCatalogGenerationState(isolation.env)).sources.team!.active!.sourceIdentity;
    const packages = [];
    for (const pluginName of ['active', 'retired']) {
      const sourceDirectory = path.join(cwd, `${pluginName}-commands`);
      await fs.outputFile(path.join(sourceDirectory, 'run.mjs'), 'process.exit(0);\n');
      packages.push(await syncManagedCommandPackage({ producer: { sourceId: 'team', sourceIdentity, pluginName, kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null, placementKey: null },
        sourceDirectory, sets: [{ set: 'tools', state: 'present', entries: [normalizeCommandDefinition({ key: 'run', runner: 'node', entry: 'run.mjs' })] }], env: isolation.env }));
    }
    await createNativeDependencyCatalog(source, [{ name: 'active' }]);
    await fs.remove(path.join(source, 'plugins', 'retired'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true });
    const retained = await runPublicLifecycle('remove', ['team/active'], location, runtime);
    expect(retained).toMatchObject({ status: 'blocked', data: { changes: { requirements: 'none', outputs: 'none' } },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'dependencyStillRequired' })]) });
    const result = await runPublicLifecycle('remove', ['team/active', 'team/retired'], location, runtime);
    expect(result.status, JSON.stringify(result)).toMatch(/^(success|partial)$/u);
    const data = result.data as LifecycleData;
    expect(data.commandResults?.map((entry) => entry.producer.pluginName).sort(), JSON.stringify(result)).toEqual(['active', 'retired']);
    for (const value of packages) {
      expect(data.commandResults?.flatMap((entry) => entry.commandIds)).toEqual(expect.arrayContaining(value.commandIds));
      expect((await resolveManagedCommand(value.commandIds[0]!, isolation.env)).view.availability).toBe('ready');
    }
  });
  it.each([[['generic']], [['generic', 'pi']]])('reports foreign output blockers with independently observed targets %j', async (targets) => {
    const { location, output } = await fixture({ targets });
    const installed = await runPublicLifecycle('install', ['team/demo'], location);
    expect(installed.status, JSON.stringify(installed)).toBe('success');
    const marker = path.join(output, '.agent-workflows-owner.json');
    await fs.writeJson(marker, { ...await fs.readJson(marker), owner: 'foreign' });
    const status = await runPublicPluginStatus([], location, { nativeCliRunner: piRunner });
    // The exact Pi package registration supplies an independent verified target.
    expect(status.status).toBe(targets.includes('pi') ? 'partial' : 'blocked');
    expect(status.data).toMatchObject({ inventory: [expect.objectContaining({ targetResults: expect.arrayContaining([
      expect.objectContaining({ target: 'generic', content: 'conflict', blockerCodes: ['portableOutputConflict'] }),
    ]) })] });
    expect(status.diagnostics).toContainEqual(expect.objectContaining({ code: 'portableOutputConflict', subject: { pluginId: 'team/demo', target: 'generic', scope: 'project' } }));
    if (targets.includes('pi')) expect(status.data).toMatchObject({ inventory: [expect.objectContaining({ targetResults: expect.arrayContaining([
      expect.objectContaining({ target: 'pi', observation: 'verified', content: 'satisfied', deploymentObservations: [expect.objectContaining({
        after: expect.objectContaining({ registration: 'present', consumers: [expect.objectContaining({ activation: 'unknown' })] }),
      })] }),
    ]) })] });
  });

  it.each(['fetch', 'activation'] as const)('continues a healthy source when another refresh fails during %s', async (failureStage) => {
    const first = await fixture({ sourceId: 'alpha', name: 'first' });
    const second = await fixture({ sourceId: 'beta', name: 'second' });
    const { location } = first;
    const config = await readCatalogSourcesConfigSnapshot(location.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'alpha', type: 'path', primary: true, path: first.source },
      { id: 'beta', type: 'path', primary: false, path: second.source },
    ] }, expectedDigest: config.digest, env: location.env });
    const plugins = ['alpha/first', 'beta/second'];
    expect((await runPublicLifecycle('install', plugins, { ...location, only: 'requirements' })).status).toBe('success');
    for (const source of [first.source, second.source]) {
      const catalog = path.join(source, 'catalog-manifest.json');
      await fs.writeJson(catalog, { ...await fs.readJson(catalog), catalogVersion: '1.0.1' });
    }
    if (failureStage === 'fetch') await fs.remove(second.source);
    let interrupted = false;
    const result = await runPublicLifecycle('sync', plugins, { ...location, refresh: true, yes: true }, {
      debugLogger: { log: async (event) => {
        if (failureStage === 'activation' && !interrupted && event.type === 'performance:stage'
          && event.data?.name === 'recovery.plan' && event.data?.phase === 'success') {
          interrupted = true;
          await fs.remove(second.source);
        }
      } },
    });
    expect(result.status, JSON.stringify(result)).toBe('partial');
    expect(result.data).toMatchObject({ changes: { outputs: 'changed' }, targetResults: expect.arrayContaining([
      expect.objectContaining({ pluginId: 'alpha/first', execution: 'applied', observation: 'verified' }),
      expect.objectContaining({ pluginId: 'beta/second', execution: 'not-run', content: 'unknown' }),
    ]), remainingTargets: [{ pluginId: 'beta/second', target: 'generic', scope: 'project' }] });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ subject: { sourceId: 'beta' } }));
    expect(await fs.pathExists(first.output)).toBe(true);
    expect(await fs.pathExists(second.output)).toBe(false);
    if (failureStage === 'activation') expect(interrupted).toBe(true);
  });
  it('keeps completed targets and unknown script effects when another target fails', async () => {
    const { location, output } = await fixture({ script: 'fail-pi', targets: ['generic', 'pi'] });
    const result = await runPublicLifecycle('install', ['team/demo'], { ...location, yes: true, scriptTimeout: '1000' });
    expect(result.status, JSON.stringify(result)).toBe('partial');
    expect(result.data).toMatchObject({ changes: { requirements: 'changed', outputs: 'changed' },
      targetResults: [expect.objectContaining({ target: 'pi', execution: 'failed' }),
        expect.objectContaining({ target: 'generic', execution: 'applied', observation: 'verified' })],
      remainingTargets: [{ pluginId: 'team/demo', target: 'pi', scope: 'project' }] });
    expect(await fs.pathExists(output)).toBe(true);
  });

  it.each([false, true])('preserves a verified generic target when the Pi install is interrupted (cleanup failed: %s)', async (cleanupFailed) => {
    const { location, output } = await fixture({ targets: ['generic', 'pi'] });
    const signal = 'SIGINT';
    const previous = new Set(process.listeners(signal));
    const capture = createCapturedCliIo();
    let handler: NodeJS.SignalsListener;
    let genericFinished = false;
    let piStarted = false;
    const interrupt = () => {
      if (genericFinished && piStarted) handler(signal);
    };
    const running = runCli(['plugin', 'install', 'team/demo', '--scope', 'project', '--yes', '--json'], {
      cwd: location.cwd, env: location.env, interactive: false, io: capture.io,
      nativeCliRunner: async (invocation) => {
        if (invocation.args[0] !== 'install') return piRunner(invocation);
        // Pi has persisted its registration but has not returned a result to AW.
        await piRunner(invocation);
        piStarted = true;
        interrupt();
        if (!invocation.signal!.aborted) await new Promise<void>((resolve) => invocation.signal!.addEventListener('abort', () => resolve(), { once: true }));
        if (cleanupFailed) throw new NativeCliError({ invocation, stdout: '', stderr: '', exitCode: 1,
          cleanupError: new Error('The controlled Pi process did not confirm cleanup.') });
        throw invocation.signal!.reason;
      },
      debugLogger: { log(event) {
        if (event.data?.name === 'recovery.child.execute' && event.data.phase === 'success') {
          genericFinished = true;
          interrupt();
        }
      } },
    });
    // In this Vitest process deliver SIGINT only to the current CLI handler.
    const listeners = process.listeners(signal).filter((entry) => !previous.has(entry));
    expect(listeners).toHaveLength(1);
    handler = listeners[0]!;
    expect(await running).toBe(cleanupFailed ? 1 : 130);
    const result: Awaited<ReturnType<typeof runPublicLifecycle>> = JSON.parse(capture.readStdout());
    expect(result).toMatchObject({ status: 'partial', data: {
      changes: { requirements: 'changed', outputs: 'changed' },
      targetResults: expect.arrayContaining([expect.objectContaining({ target: 'pi', execution: 'partial', observation: 'unknown' }),
        expect.objectContaining({ target: 'generic', execution: 'applied', observation: 'verified' })]),
      remainingTargets: [{ pluginId: 'team/demo', target: 'pi', scope: 'project' }],
    } });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: cleanupFailed ? 'processCleanupUnconfirmed' : 'operationInterrupted' }));
    expect(result.nextActions.filter((action) => action.kind === 'command').map((action) => action.argv)).toEqual([
      ['aw', 'plugin', 'sync', 'team/demo', '--context', 'project', '--target', 'pi'],
    ]);
    expect(await fs.readFile(path.join(output, 'SKILL.md'), 'utf8')).toContain('Use demo.');
    const retried = await runPublicLifecycle('sync', ['team/demo'], { ...location, targets: ['pi'], yes: true });
    expect(retried, JSON.stringify(retried)).toMatchObject({ status: 'success', data: { remainingTargets: [] } });
  });

  it('shows removal effects and observed targets before changing a requirement', async () => {
    const { location, output } = await fixture();
    expect((await runPublicLifecycle('install', ['team/demo'], location)).status).toBe('success');
    const before = await observeIntent(location);
    const result = await runPublicLifecycle('remove', ['team/demo'], location);
    expect(result.status, JSON.stringify(result)).toBe('blocked');
    expect(result.data).toMatchObject({ confirmation: { required: true, provided: false, effects: [expect.objectContaining({ code: 'removeOwnedOutput' })] },
      changes: { requirements: 'none', outputs: 'none' }, targetResults: [expect.objectContaining({ pluginId: 'team/demo', execution: 'not-run' })] });
    expect(await observeIntent(location)).toEqual(before);
    expect(await fs.pathExists(output)).toBe(true);
    const removed = await runPublicLifecycle('remove', ['team/demo'], { ...location, yes: true });
    expect(removed.status, JSON.stringify(removed)).toBe('success');
    expect(await fs.pathExists(output)).toBe(false);
  });
  it('rejects malformed requests before scope normalization or writes', async () => {
    const { location }=await fixture();
    const result=await runPublicLifecycle('install', ['team/demo'], { ...location, context: 'invalid' });
    expect(result).toMatchObject({ command: 'plugin.install', status: 'failed', data: {} });
    expect(await observeIntent(location)).toEqual({ state: 'absent' });
  });

  it('blocks empty targets before fetching a source or saving requirements', async () => {
    const { location }=await fixture({ active: false, targets: [] });
    const result=await runPublicLifecycle('install', ['team/demo'], location);
    expect(result.status).toBe('blocked'); expect(result.diagnostics[0]?.code).toBe('noTargetsEnabled');
    expect(await observeIntent(location)).toEqual({ state: 'absent' });
    expect((await readCatalogGenerationState(location.env)).sources.team?.active).toBeUndefined();
  });

  it('does not activate a first source or save requirements before script confirmation', async () => {
    const { location, output }=await fixture({ active: false, script: true });
    const result=await runPublicLifecycle('install', ['team/demo'], location);
    expect(result.status).toBe('blocked');
    expect((result.data as LifecycleData).confirmation).toMatchObject({ required: true, provided: false, effects: [expect.objectContaining({ code: 'runPreApply' })] });
    expect(Object.values((result.data as LifecycleData).changes)).toEqual(['none', 'none', 'none', 'none', 'none']);
    expect(await observeIntent(location)).toEqual({ state: 'absent' });
    expect((await readCatalogGenerationState(location.env)).sources.team?.active).toBeUndefined();
    expect(await fs.pathExists(output)).toBe(false);
    const installed=await runPublicLifecycle('install', ['team/demo'], { ...location, yes: true });
    expect(installed.status, JSON.stringify(installed)).toBe('success');
    expect((installed.data as LifecycleData).changes).toMatchObject({ sources: 'changed', requirements: 'changed', outputs: 'changed' });
    expect(await fs.pathExists(output)).toBe(true);
  });

  it('filters one install without changing the saved target policy and retains unknown native status', async () => {
    const { location, output }=await fixture({ targets: ['generic', 'pi'] });
    const result=await runPublicLifecycle('install', ['team/demo'], { ...location, target: ['generic'] });
    expect(result.status, JSON.stringify(result)).toBe('success');
    expect((result.data as LifecycleData).targetResults.map((target) => target.target)).toEqual(['generic']);
    expect(await fs.pathExists(output)).toBe(true);
    expect(await fs.pathExists(path.join(location.cwd, '.pi', 'skills', 'demo'))).toBe(false);
    const status=await runPublicPluginStatus([], location, { nativeCliRunner: piRunner });
    expect(status.status, JSON.stringify(status)).toBe('partial');
    expect(status.data).toMatchObject({ allSatisfied: null, targetPolicy: { targets: ['generic', 'pi'] }, inventory: [expect.objectContaining({
      targetResults: expect.arrayContaining([expect.objectContaining({ target: 'pi', content: 'unknown', observation: 'unknown' })]),
    })] });
  });

  it('keeps ordinary removal blocked offline while both only modes remain available', async () => {
    const { location, source, output }=await fixture();
    const installed=await runPublicLifecycle('install', ['team/demo'], location);
    expect(installed.status, JSON.stringify(installed)).toBe('success');
    await fs.remove(path.join(location.env.AW_HOME!, 'catalog-state.json'));
    await fs.remove(path.join(location.env.AW_HOME!, 'catalog-store'));
    await fs.remove(source);
    const result=await runPublicLifecycle('remove', ['team/demo'], { ...location, yes: true });
    expect(result.status).toBe('blocked');
    expect((await observeIntent(location)).state).toBe('valid');
    expect(await fs.pathExists(output)).toBe(true);
    const canceled=await runPublicLifecycle('remove', ['team/demo'], { ...location, only: 'requirements' });
    expect(canceled.status).toBe('success'); expect(await fs.pathExists(output)).toBe(true);
    await setTargets(location, []);
    const cleaned=await runPublicLifecycle('remove', ['team/demo'], { ...location, only: 'outputs', target: ['generic'], yes: true });
    expect(cleaned.status, JSON.stringify(cleaned)).toBe('success'); expect(await fs.pathExists(output)).toBe(false);
  });

  it('lists direct requirements offline and shows public metadata without private paths', async () => {
    const { location, source }=await fixture();
    const saved=await runPublicLifecycle('install', ['team/demo'], { ...location, only: 'requirements' });
    expect(saved.status).toBe('success'); expect((saved.data as LifecycleData).targetResults).toEqual([]);
    const shown=await runPublicPluginShow('team/demo', location);
    expect(shown.status).toBe('success'); expect(shown.data).toMatchObject({ pluginId: 'team/demo', version: '1.0.0' });
    expect(JSON.stringify(shown)).not.toContain(location.env.AW_HOME!);
    await fs.remove(source);
    const listed=await runPublicPluginList({ ...location, requested: true });
    expect(listed.status).toBe('success'); expect(listed.data).toMatchObject({ items: [{ pluginId: 'team/demo', direct: true }] });
  });
});
