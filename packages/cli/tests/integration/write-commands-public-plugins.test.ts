import { describe, beforeEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { resolvePreferencesPath, writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';
import { listManagedCommandPackages } from '../../src/utils/managed-command-store.js';
import { commandRuntimeConfigSnapshotPath } from '../../src/utils/managed-command-snapshots.js';
import {
  AW_RUNTIME_CONFIG_BINDING_PATH,
  preparePluginNativeTools,
} from '@lesliechan721/aw-plugin-core';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import { SKILL_OWNER_MARKER, type SkillOwnerMarker } from '../../src/utils/ownership.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { prepareSubagentForNativeFixture } from '../helpers/subagent-native-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import type { LifecycleData } from '../../src/commands/public-lifecycle-result.js';

import {
  createCodexNativeTestRuntime,
  installWriteCommand,
  readFixtureRequirements,
  replaceCatalogSourcesConfig,
  prepareSubagentCompositionPublicCommandFixture,
} from '../helpers/write-command-fixture.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';

function nativePackage(runtime: { packageRoots: Map<string, string> }, name: string) {
  const matches = [...runtime.packageRoots].filter(([id]) => id.startsWith(`${name}@`));
  expect(matches).toHaveLength(1);
  const [registrationId, root] = matches[0]!;
  return { registrationId, root };
}

const guideSelector = 'team/agent-subagent';

async function installedGuidePackage(env: NodeJS.ProcessEnv) {
  const { packages } = await listManagedCommandPackages(env);
  expect(packages).toEqual([expect.objectContaining({ selector: guideSelector, availability: 'ready' })]);
  return packages[0]!;
}

async function guidePackagePointer(env: NodeJS.ProcessEnv): Promise<string> {
  const { resourceRoot } = await installedGuidePackage(env);
  return path.resolve(resourceRoot!, '..', '..', 'current.json');
}

describe('five namespaced write commands', () => {
  beforeEach(async () => {
    installNativeTestDiscovery({ platforms: ['codex', 'claude', 'pi'] });
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  it('installs the three staged toolkits and Guide together without sharing command ownership', async () => {
    // Test Value Gate: this checks the actual staged dependency graph and public
    // installation and ownership boundaries in one workspace.
    const isolation = getCurrentSourceTestIsolation();
    const { env, layout: { fixtureCwd: cwd } } = isolation;
    const runtime = await createCodexNativeTestRuntime(isolation);
    const catalog = path.join(cwd, 'shipped-catalog');
    const staged = fileURLToPath(new URL('../../plugins-dist/', import.meta.url));
    await fs.copy(staged, catalog);
    const identity = `sha256:${'1'.repeat(64)}`;
    await fs.outputJson(path.join(catalog, '.aw-generated.json'), {
      schemaVersion: 1, kind: 'catalog', workspaceIdentity: identity, sourceIdentity: identity,
    });
    const run = async <T>(args: string[]) => {
      const result = await runCliEntry([...args, '--json'], { cwd, env, interactive: false, nativeCliRunner: runtime.nativeCliRunner });
      expect(result.exitCode, result.stdout || result.stderr).toBe(0);
      const receipt = result.parseJsonStdout<{ schemaVersion: number; status: string; data: T }>();
      expect(receipt).toMatchObject({ schemaVersion: 2, status: 'success' });
      return receipt.data;
    };
    await run(['source', 'add', 'staged', '--path', catalog, '--primary', '--no-auto-check', '--yes']);
    await run(['source', 'sync', 'staged', '--yes']);
    await run(['target', 'set', 'codex', '--context', 'project']);
    const [content, skills, toolkit] = ['staged/agent-content-toolkit', 'staged/agent-skill-toolkit', 'staged/aw-development-toolkit'] as const;
    const guide = 'staged/agent-subagent';
    await run(['plugin', 'config', 'set', guide, 'generalTaskProfile', '--platform', 'codex',
      '--value-json', '{"executor":"native"}']);
    const capabilityRequirements = { requires: { aw: {
      capabilities: expect.arrayContaining(['aw.managed-commands.v2', 'aw.native-tools.v3']),
    } } };
    for (const [pluginId, expected] of [
      [content, { dependencies: [] }],
      [skills, { dependencies: [content] }],
      [toolkit, { dependencies: expect.arrayContaining([content, skills]), ...capabilityRequirements }],
      [guide, capabilityRequirements],
    ] as const) {
      expect(await run(['plugin', 'show', pluginId])).toMatchObject({ pluginId, ...expected });
    }

    const rules = path.join(cwd, '.codex', 'rules');
    const foreign = path.join(rules, 'local.rules');
    await fs.outputFile(foreign, '# Existing project rules\n');
    const install = await run<LifecycleData>(['plugin', 'install', toolkit, guide, '--scope', 'project', '--target', 'codex', '--yes']);
    expect(install.remainingTargets).toEqual([]);
    expect(install.targetResults).toEqual(expect.arrayContaining([content, skills, toolkit, guide].map((pluginId) =>
      expect.objectContaining({ pluginId, target: 'codex', scope: 'project', execution: 'applied' }))));
    expect(install.targetResults).toHaveLength(4);
    const toolkitSkills = Object.entries({
      'agent-content-toolkit': ['agent-content'],
      'agent-skill-toolkit': ['agent-skill', 'audit-agent-skill-evals'],
      'aw-development-toolkit': ['develop-aw', 'publish-aw-catalog'],
    });
    const toolkitFiles = new Map<string, Buffer>();
    for (const [name, expected] of toolkitSkills) {
      const packageRoot = nativePackage(runtime, name).root;
      expect((await fs.readdir(path.join(packageRoot, 'skills'))).sort()).toEqual(expected);
      for (const skill of expected) {
        const file = path.join(packageRoot, 'skills', skill, 'SKILL.md');
        toolkitFiles.set(file, await fs.readFile(file));
      }
    }
    const list = await run<{ packages: Array<{ selector: string; packageId: string }> }>(['command', 'list']);
    expect(list.packages).toEqual([expect.objectContaining({ selector: guide, availability: 'ready' })]);
    const show = await run<{ commands: unknown[] }>(['command', 'show', guide]);
    expect(show.commands).toEqual([expect.objectContaining({
      packageId: list.packages[0]!.packageId,
      owner: { kind: 'plugin', producer: { sourceId: 'staged', sourceIdentity: expect.any(String), pluginName: 'agent-subagent' } },
      runtimeConfigPlatforms: ['codex'],
    })]);
    const guideSkill = path.join(nativePackage(runtime, 'agent-subagent').root, 'skills/spawn-subagent');
    await expect(fs.pathExists(path.join(guideSkill, 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(guideSkill, 'references'))).resolves.toBe(false);
    const guideRules = path.join(rules, 'aw-staged-agent-subagent-subagent-commands.rules');
    const start = ['aw', 'command', 'run', `${guide}/codex`, '--', 'start'];
    expect(await fs.readFile(guideRules, 'utf8')).toContain(JSON.stringify(start));
    expect((await fs.readdir(rules)).sort()).toEqual([path.basename(guideRules), path.basename(foreign)].sort());

    await run(['plugin', 'remove', guide, '--only', 'outputs', '--scope', 'project', '--target', 'codex', '--yes']);
    expect(await fs.readdir(rules)).toEqual([path.basename(foreign)]);
    await expect(fs.readFile(foreign, 'utf8')).resolves.toBe('# Existing project rules\n');
    for (const [file, bytes] of toolkitFiles) await expect(fs.readFile(file)).resolves.toEqual(bytes);
    await expect(run(['command', 'list'])).resolves.toEqual(list);
  }, 120_000);

  it.each(['codex', 'claude'] as const)('runs the installed %s Guide command with its applied snapshot in a local v6 backend', async (platform) => {
    // Test Value Gate: real installation connects the rendered call and permission to AW and a live fake v6 backend.
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex', 'claude'] });
    const { isolation, runtime, runPublic } = await prepareSubagentCompositionPublicCommandFixture();
    const claude = await createClaudeNativeTestRuntime(isolation);
    const project = platform === 'claude'
      ? path.join(isolation.layout.fixtureCwd, 'claude-backend-project') : isolation.layout.fixtureCwd;
    await fs.ensureDir(path.join(project, '.git'));
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const runtimeSourceRoot = path.join(isolation.layout.fixtureCwd, 'guide-runtime-source');
    await fs.copy(path.join(repositoryRoot, 'plugins/agent-subagent'), runtimeSourceRoot);
    await prepareSubagentForNativeFixture(runtimeSourceRoot);
    await preparePluginNativeTools(runtimeSourceRoot, (await readPluginManifest(runtimeSourceRoot)).manifest);
    const helpers = await import(pathToFileURL(path.join(runtimeSourceRoot, 'scripts/fixtures/subagent-integration.mjs')).href);
    const { openRun, storeContext } = await import(pathToFileURL(path.join(
      runtimeSourceRoot, 'commands/scripts/runtime/store.mjs',
    )).href);
    const cleanups: Array<() => Promise<void>> = [() => fs.remove(runtimeSourceRoot)];
    const fixture = await helpers.fixture({ signal: new AbortController().signal, diagnostic: () => {}, after: (cleanup: () => Promise<void>) => { cleanups.push(cleanup); } });
    const cliEntry = path.join(repositoryRoot, 'packages/cli/dist/index.js');
    const scenario = path.join(fixture.directory, 'public-managed-scenario');
    await fs.ensureDir(scenario);
    await fs.writeJson(path.join(scenario, 'scenario.json'), { echo: true, finalText: 'Public Guide final result.', adapterLifetimeMs: 60000, backendLifetimeMs: 60000 });
    const localEnvironmentKeys = new Set([
      'PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
      'AW_HOME', 'AW_CODEX_HOME', 'AW_CLAUDE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
      'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'AW_TEST_PROCESS_TREE_ID',
    ]);
    const environment = {
      ...Object.fromEntries(Object.entries(isolation.env).filter(([key]) => localEnvironmentKeys.has(key.toUpperCase()))),
      HOME: fixture.homeRoot,
      USERPROFILE: fixture.homeRoot,
      TMPDIR: fixture.temporaryRoot,
      TMP: fixture.temporaryRoot,
      TEMP: fixture.temporaryRoot,
      FIXTURE_SCENARIO_FILE: path.join(scenario, 'scenario.json'),
      FIXTURE_RUN_DIRECTORY: scenario,
      FIXTURE_GENERATIONS: fixture.generations,
    };
    const invoke = (args: string[]) => new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cliEntry, ...args], { cwd: project, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Public managed Guide command timed out.')); }, 30000);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
    });
    const invokeGuide = (args: string[]) => invoke(['command', 'run', `${guideSelector}/${platform}`, '--', ...args]);
    let run: string | undefined;
    try {
      const adapterSource = path.join(isolation.layout.fixtureCwd, 'public-adapter');
      await fs.ensureDir(adapterSource);
      await fs.copyFile(path.join(fixture.directory, 'fake-adapter.mjs'), path.join(adapterSource, 'adapter.mjs'));
      const adapter = await runPublic(['command', 'install', adapterSource, '--name', 'public-v6-adapter', '--runner', 'node', '--entry', 'adapter.mjs', '--args-json', '["fixed-argv"]', '--yes']);
      expect(adapter.exitCode).toBe(0);
      const adapterId = (adapter.payload.data as { commands: Array<{ id: string }> }).commands[0]!.id;
      const saveRegistry = (target: 'codex' | 'claude', argument: string) => runPublic([
        'plugin', 'config', 'set', guideSelector, 'subagentCommands', '--context', 'user', '--platform', target,
        '--value-json', JSON.stringify([{ key: 'fixture', adapter: 'custom-managed', commandId: adapterId, args: [argument],
          modelsPolicy: 'override', models: [{ id: `${target}-fixture-model`, efforts: ['medium'] }] }]),
      ]);
      for (const target of ['codex', 'claude'] as const) {
        expect(await saveRegistry(target, `${target}-applied`)).toMatchObject({ exitCode: 0 });
      }
      const preview = await installWriteCommand([guideSelector], { cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project' }, { ...runtime, previewOperationPlan: true });
      expect(preview.operationPlan, JSON.stringify(preview.targetResults)).toBeDefined();
      const review = buildOperationReviewProjection({ intent: { kind: 'pluginWrite', action: 'install', pluginId: 'team/agent-subagent', platform: 'codex', scope: 'project' }, evidence: { catalog: { configDigest: 'fixture', compositeDigest: 'fixture' }, operationPlan: preview.operationPlan } });
      expect(review.changes).toContainEqual(expect.objectContaining({
        title: '命令路由与审批',
        description: expect.stringContaining(`aw command run ${guideSelector}/codex -- start`),
      }));
      const installed = await runPublic(['plugin', 'install', guideSelector, '--scope', 'project', '--target', 'codex', '--yes']);
      expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0, payload: { schemaVersion: 2, status: 'success' } });
      if (platform === 'claude') {
        const result = await runCliEntry(['plugin', 'install', guideSelector, '--scope', 'project', '--target', 'claude', '--yes', '--json'], {
          cwd: project, env: isolation.env, interactive: false, nativeCliRunner: claude.nativeCliRunner,
        });
        expect(result.exitCode, result.stdout || result.stderr).toBe(0);
      }
      const guideCommand = await installedGuidePackage(isolation.env);
      const appliedPlatforms = platform === 'claude' ? ['claude', 'codex'] : ['codex'];
      expect(guideCommand).toMatchObject({
        owner: { kind: 'plugin', producer: { sourceId: 'team', pluginName: 'agent-subagent' } },
        hasFallback: false,
      });
      expect([...guideCommand.runtimeConfigPlatforms].sort()).toEqual(appliedPlatforms);
      expect([...guideCommand.subcommands].sort()).toEqual(['inspect', 'message', 'result', 'send', 'start', 'stop', 'wait']);
      const allowed = ['aw', 'command', 'run', `${guideSelector}/codex`, '--', 'start'];
      expect(review.changes).toContainEqual(expect.objectContaining({
        title: expect.stringMatching(/^Codex 权限规则/u), description: expect.stringContaining(JSON.stringify(allowed)),
      }));
      const permission = await fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex/rules/aw-team-agent-subagent-subagent-commands.rules'), 'utf8');
      const prefixes = [...permission.matchAll(/prefix_rule\(pattern = (\[.*\]), decision = "allow"\)/gu)]
        .map(([, prefix]) => JSON.parse(prefix!));
      const command = allowed.slice(0, -1);
      expect(prefixes).toEqual(expect.arrayContaining([
        allowed, ...['send', 'wait', 'result', 'stop', 'inspect'].map((route) => [...command, route]),
      ]));
      expect(prefixes).toHaveLength(6);
      const references = path.join(nativePackage(platform === 'claude' ? claude : runtime, 'agent-subagent').root,
        'skills/spawn-subagent/references');
      const installedReference = await fs.readFile(path.join(references, 'external-execution.md'), 'utf8');
      const publishedStart = installedReference.match(/^aw command run [a-z0-9/-]+ -- start(?= --executor )/mu)?.[0];
      expect(publishedStart).toBe(`aw command run ${guideSelector}/${platform} -- start`);
      expect(await fs.readFile(path.join(references, 'executor-selection.md'), 'utf8'))
        .toContain(`aw command run ${guideSelector}/${platform} -- inspect --executor`);
      if (!publishedStart) throw new Error('The installed Skill did not publish a start command.');
      if (platform === 'claude') {
        const settings = await fs.readJson(path.join(project, '.claude', 'settings.local.json'));
        expect(settings.permissions.allow).toContain(`Bash(${publishedStart} *)`);
      }
      expect(await saveRegistry(platform, `${platform}-saved-only`)).toMatchObject({ exitCode: 0 });
      const inspected = await invokeGuide(['inspect', '--executor', 'fixture', '--json']);
      expect(inspected, inspected.stderr).toMatchObject({ exitCode: 0 });
      expect(JSON.parse(inspected.stdout)).toMatchObject({
        executor: 'fixture', source: 'configured', environment: 'skipped',
        models: [{ id: `${platform}-fixture-model`, efforts: ['medium'] }],
      });
      const schema = await invoke(['plugin', 'config', 'schema', guideSelector, '--platform', platform, '--json']);
      expect(schema.exitCode, schema.stderr).toBe(0);
      expect(JSON.parse(schema.stdout)).toMatchObject({ data: { fields: {
        simpleTaskProfile: { suggestions: { provider: 'executor-model-profile', hint: 'fast' },
          properties: { model: { suggestions: { provider: 'executor-models', dependsOn: ['executor'] } } } },
      } } });
      const suggestions = await invoke(['plugin', 'config', 'suggestions', guideSelector, 'simpleTaskProfile.model',
        '--platform', platform, '--dep', 'executor=fixture', '--json']);
      expect(suggestions.exitCode, suggestions.stderr).toBe(0);
      expect(JSON.parse(suggestions.stdout)).toMatchObject({ data: {
        status: 'ok', items: [{ value: `${platform}-fixture-model` }],
      } });
      await fs.writeFile(path.join(project, 'prompt.txt'), 'Public installation task.\n');
      const started = await invoke([
        ...publishedStart.split(' ').slice(1), '--executor', 'fixture', '--workspace', fixture.workspace, '--prompt-file', 'prompt.txt', '--instructions-file', '',
      ]);
      run = helpers.field(started.stdout, 'run');
      expect(started, JSON.stringify(started)).toMatchObject({ exitCode: 0, stderr: '' });
      expect(started.stdout).toMatch(/^started \S+ communication=true resume=false\n$/u);
      const observed = await helpers.eventually(async () => fs.readJson(path.join(scenario, 'observed.json')), 'public installed Guide backend');
      process.kill(observed.pid, 0);
      expect(observed.argv).toEqual(['fixed-argv']);
      expect(observed.request.args).toEqual([`${platform}-applied`]);
      expect(observed.request.prompt).toBe('Public installation task.\n');
      expect(observed.request.resume).toBe(true);
      const { meta } = await openRun(await storeContext({ homeRoot: fixture.homeRoot }), run);
      expect(meta.installedIdentity).toMatchObject({ platform, pluginId: guideSelector });
      const sent = await invokeGuide(['send', '--run', run!, '--text', 'Continue.']);
      expect(sent).toMatchObject({ exitCode: 0, stdout: `queued ${run}\n` });
      await helpers.eventually(async () => (await fs.readFile(path.join(scenario, 'inputs.jsonl'), 'utf8')).includes('Continue.'), 'public wrapped worker still alive after start');
      await fs.writeFile(path.join(scenario, 'finish'), '');
      const deadline = Date.now() + 10000;
      let final: Awaited<ReturnType<typeof invokeGuide>>;
      do {
        final = await invokeGuide(['wait', '--run', run!, '--timeout-ms', String(Math.max(0, deadline - Date.now()))]);
        expect(final).toMatchObject({ exitCode: 0 });
      } while (!helpers.terminalPattern.test(final.stdout) && Date.now() < deadline);
      expect(final.stdout).toContain('Public Guide final result.');
      const result = await invokeGuide(['result', '--run', run!]);
      expect(result).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('Public Guide final result.') });
    } finally {
      try {
        if (run) {
          const stopped = await invokeGuide(['stop', '--run', run]);
          expect(stopped, JSON.stringify(stopped)).toMatchObject({ exitCode: 0 });
          // invokeGuide creates this run outside the fixture's tracked commands.
          const { meta } = await openRun(await storeContext({ homeRoot: fixture.homeRoot }), run);
          // A saved final result does not mean the worker has released its cwd.
          // Windows cannot remove that directory until the worker exits.
          await helpers.eventually(() => {
            try {
              process.kill(meta.worker.pid, 0);
              return false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
              return true;
            }
          }, 'public managed Guide worker exit');
        }
      } finally {
        for (const cleanup of cleanups.reverse()) await cleanup();
      }
    }
  }, 90000);

  it('keeps one Guide package and applies only the chosen platform across independent projects', async () => {
    // Test Value Gate: the installed Guide agrees with its manifest, rendered calls, and exact host permissions.
    const { isolation, runtime: codex } = await prepareSubagentCompositionPublicCommandFixture();
    const { env, layout: { fixtureCwd: cwd } } = isolation;
    const claudeRoot = path.join(cwd, 'claude-project');
    await fs.ensureDir(path.join(claudeRoot, '.git'));
    const claude = await createClaudeNativeTestRuntime(isolation);
    const piBin = path.join(cwd, 'pi-controlled-bin');
    await fs.outputFile(path.join(piBin, process.platform === 'win32' ? 'pi.exe' : 'pi'), 'controlled client entry', { mode: 0o755 });
    env.PATH = [piBin, env.PATH].filter(Boolean).join(path.delimiter);
    const nativeCliRunner = async (invocation: NativeCliInvocation) => {
      if (['pi', 'pi.exe'].includes(path.basename(invocation.command).toLowerCase())) {
        const piRoot = path.join(invocation.cwd!, '.pi');
        const settings = path.join(piRoot, 'settings.json');
        if (invocation.args[0] === 'install') {
          expect(invocation.args).toContain('--local');
          await fs.outputJson(settings, { packages: [invocation.args.at(-1)] });
          return { exitCode: 0, stderr: '', stdout: '' };
        }
        expect(invocation.args).toEqual(['list']);
        const packages: string[] = await fs.pathExists(settings) ? (await fs.readJson(settings)).packages : [];
        const entries = packages.map((source) => `  ${source}\n    ${path.resolve(piRoot, source)}`);
        return { exitCode: 0, stderr: '',
          stdout: entries.length ? `Project packages:\n${entries.join('\n')}\n` : 'No packages installed.\n' };
      }
      return claude.isClaudeInvocation(invocation) ? claude.nativeCliRunner(invocation) : codex.nativeCliRunner(invocation);
    };
    const run = async (args: string[], targetCwd = cwd) => {
      const result = await runCliEntry([...args, '--json'], { cwd: targetCwd, env, interactive: false, nativeCliRunner });
      expect(result.exitCode, result.stdout || result.stderr).toBe(0);
      return result.parseJsonStdout<{ status: string }>();
    };
    await writePreferences({ scope: 'user', cwd, env }, { ...createEmptyPreferences(), targets: ['pi', 'codex', 'claude'] });
    for (const [platform, hours] of [['codex', 8], ['claude', 48]] as const) {
      await run(['plugin', 'config', 'set', guideSelector, 'subagentRetentionHours',
        '--context', 'user', '--platform', platform, '--value-json', String(hours)]);
    }
    const install = async (platform: 'pi' | 'codex' | 'claude', project = cwd) =>
      expect(await run(['plugin', 'install', guideSelector, '--scope', 'project', '--target', platform, '--yes'], project))
        .toMatchObject({ status: 'success' });
    await install('pi');
    const piSettings = await fs.readJson(path.join(cwd, '.pi', 'settings.json'));
    expect(piSettings.packages).toHaveLength(1);
    const piPackage = path.resolve(cwd, '.pi', piSettings.packages[0]);
    await expect(fs.pathExists(path.join(piPackage, 'agents'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(piPackage, 'skills', 'spawn-subagent', 'SKILL.md'))).resolves.toBe(true);
    const piCommand = await installedGuidePackage(env);
    expect(piCommand.runtimeConfigPlatforms).toEqual(['pi']);
    await install('codex');
    const codexPackage = await installedGuidePackage(env);
    expect([...codexPackage.runtimeConfigPlatforms].sort()).toEqual(['codex', 'pi']);
    await install('claude', claudeRoot);
    const sharedPackage = await installedGuidePackage(env);
    expect(sharedPackage.packageId).toBe(piCommand.packageId);
    expect([...sharedPackage.runtimeConfigPlatforms].sort()).toEqual(['claude', 'codex', 'pi']);
    for (const runtime of [codex, claude]) {
      const skill = path.join(nativePackage(runtime, 'agent-subagent').root, 'skills/spawn-subagent');
      await expect(fs.pathExists(path.join(skill, 'SKILL.md'))).resolves.toBe(true);
      await expect(fs.pathExists(path.join(skill, 'references'))).resolves.toBe(false);
    }
    const claudeSettings = await fs.readJson(path.join(claudeRoot, '.claude', 'settings.local.json'));
    const allowed: string[] = claudeSettings.permissions.allow;
    expect(new Set(allowed)).toEqual(new Set(['start', 'send', 'wait', 'result', 'stop', 'inspect']
      .map((route) => `Bash(aw command run ${guideSelector}/claude -- ${route} *)`)));

    const snapshots = (resourceRoot: string) => Promise.all((['codex', 'claude'] as const).map((platform) =>
      fs.readJson(path.join(resourceRoot, commandRuntimeConfigSnapshotPath(platform)))));
    const before = await snapshots(sharedPackage.resourceRoot!);
    expect(before.map((snapshot) => snapshot.effectiveValues.subagentRetentionHours)).toEqual([8, 48]);
    for (const [platform, hours] of [['codex', 12], ['claude', 72]] as const) {
      await run(['plugin', 'config', 'set', guideSelector, 'subagentRetentionHours',
        '--context', 'user', '--platform', platform, '--value-json', String(hours)]);
    }
    expect((await installedGuidePackage(env)).resourceRoot).toBe(sharedPackage.resourceRoot);
    await expect(snapshots(sharedPackage.resourceRoot!)).resolves.toEqual(before);
    expect(await run(['plugin', 'config', 'apply', guideSelector, '--context', 'project', '--platform', 'claude', '--yes'], claudeRoot))
      .toMatchObject({ status: 'success' });
    const updatedPackage = await installedGuidePackage(env);
    expect(updatedPackage.packageId).toBe(sharedPackage.packageId);
    expect(updatedPackage.resourceRoot).not.toBe(sharedPackage.resourceRoot);
    const after = await snapshots(updatedPackage.resourceRoot!);
    expect(after[0]).toEqual(before[0]);
    expect(after[1].effectiveValues.subagentRetentionHours).toBe(72);
  }, 120_000);

  it('cleans exploration project outputs even when the Guide command package pointer is missing', async () => {
    // Missing weak command state must not block cleanup of exact scoped output.
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const { isolation, runtime, runPublic } = await prepareSubagentCompositionPublicCommandFixture();
    const id = 'team/agent-explore';
    const config = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    expect(await runPublic(['plugin', 'install', id, '--scope', 'project', '--yes']))
      .toMatchObject({ exitCode: 0, payload: { status: 'success' } });
    const explore = nativePackage(runtime, 'agent-explore');
    expect((await readCodexConfigFile(config)).snapshot.plugins[explore.registrationId]?.enabled).toBe(true);
    await expect(fs.pathExists(path.join(explore.root, 'scripts/aw-instructions.mjs'))).resolves.toBe(true);
    const intentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const intentBefore = await fs.readFile(intentPath);
    await fs.remove(await guidePackagePointer(isolation.env));
    expect(await runPublic(['plugin', 'remove', '--only', 'outputs', id, '--target', 'codex', '--scope', 'project', '--yes']))
      .toMatchObject({ exitCode: 0, payload: { status: 'success' } });
    const after = (await readCodexConfigFile(config)).snapshot;
    expect(after.plugins[explore.registrationId]?.enabled).not.toBe(true);
    expect((await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml'))).snapshot.plugins[explore.registrationId]?.enabled).not.toBe(true);
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    await expect(fs.pathExists(path.join(nativePackage(runtime, 'agent-subagent').root, 'skills', 'spawn-subagent', 'SKILL.md'))).resolves.toBe(true);
  }, 30_000);

  it('rematerializes exploration Skill without changing advisor or Guide output through public commands', async () => {
    // Real config apply updates one dynamic consumer and preserves independent packages and the command snapshot.
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const { isolation, runtime, runPublic } = await prepareSubagentCompositionPublicCommandFixture();
    const id = 'team/agent-explore';
    const saveProfile = (model: string, effort: string, apply = false) => runPublic([
      'plugin', 'config', 'set', id, 'exploreProfile', '--context', 'project', '--platform', 'codex',
      '--value-json', JSON.stringify({ executor: 'native', model, reasoningEffort: effort }), ...(apply ? ['--apply', '--yes'] : []),
    ]);
    expect(await saveProfile('initial-explore', 'high')).toMatchObject({ exitCode: 0 });
    expect(await runPublic(['plugin', 'install', id, 'team/agent-advisor', '--scope', 'project', '--yes']))
      .toMatchObject({ exitCode: 0, payload: { status: 'success' } });
    const explore = nativePackage(runtime, 'agent-explore');
    const advisor = nativePackage(runtime, 'agent-advisor');
    const guide = nativePackage(runtime, 'agent-subagent');
    const exploreFile = path.join(explore.root, 'skills/explore-facts/SKILL.md');
    const advisorFile = path.join(advisor.root, 'skills/consult-advisor/SKILL.md');
    const guideSkillFile = path.join(guide.root, 'skills/spawn-subagent/SKILL.md');
    const guideRole = path.join(isolation.layout.fixtureCwd, '.codex/agents/aw-team-agent-subagent-subagent.toml');
    await expect(fs.pathExists(guideRole)).resolves.toBe(false);
    const initialExplore = await fs.readFile(exploreFile, 'utf8');
    const initialAdvisor = await fs.readFile(advisorFile);
    const initialGuideSkill = await fs.readFile(guideSkillFile);
    const initialSnapshot = await installedGuidePackage(isolation.env).then(pack =>
      fs.readJson(path.join(pack.resourceRoot!, commandRuntimeConfigSnapshotPath('codex'))));
    expect(initialExplore).toContain('"initial-explore"');
    expect(initialSnapshot).toMatchObject({ allowedKeys: ['subagentCommands', 'subagentRetentionHours'],
      effectiveValues: { subagentCommands: [], subagentRetentionHours: 24 } });
    for (const [root, name] of [[explore.root, 'explore-facts'], [advisor.root, 'consult-advisor']]) {
      const receipt = await fs.readJson(path.join(root!, SKILL_OWNER_MARKER)) as SkillOwnerMarker;
      expect(receipt.nativeProjection?.components.filter(component => component.relativeOutputs.some(file => file.endsWith('/SKILL.md')))
        .map(component => component.nativeName)).toEqual([name]);
      await expect(fs.pathExists(path.join(root!, 'skills', name!, AW_RUNTIME_CONFIG_BINDING_PATH))).resolves.toBe(false);
    }
    expect(await saveProfile('saved-explore', 'medium')).toMatchObject({ exitCode: 0, payload: { data: { apply: { state: 'skipped' } } } });
    await expect(fs.readFile(exploreFile, 'utf8')).resolves.toBe(initialExplore);
    expect(await saveProfile('updated-explore', 'high', true)).toMatchObject({ exitCode: 0 });
    await expect(fs.readFile(exploreFile, 'utf8')).resolves.toContain('"updated-explore"');
    await expect(fs.readFile(advisorFile)).resolves.toEqual(initialAdvisor);
    await expect(fs.readFile(guideSkillFile)).resolves.toEqual(initialGuideSkill);
    await expect(fs.pathExists(guideRole)).resolves.toBe(false);
    const guidePackage = await installedGuidePackage(isolation.env);
    await expect(fs.readJson(path.join(guidePackage.resourceRoot!, commandRuntimeConfigSnapshotPath('codex')))).resolves.toEqual(initialSnapshot);
  }, 120_000);

  it('preserves synthetic Codex project roles while adding and removing the user root through public commands', async (test) => {
    // Test Value Gate: shared package activation cannot move or remove independent scoped Agent output.
    const isolation = getCurrentSourceTestIsolation();
    const { env, layout: { fixtureCwd: cwd } } = isolation;
    await writePreferences({ scope: 'user', cwd, env }, { ...createEmptyPreferences(), targets: ['codex'] });
    const timing = createCommandTestTiming(test);
    const pluginName = 'synthetic-role-fixture';
    const selector = `team/${pluginName}`;
    const sourceRoot = path.join(cwd, 'synthetic-role-catalog');
    const pluginRoot = path.join(sourceRoot, 'plugins', pluginName);
    const configureManifest = (manifest: {
      platforms?: string[];
      skills?: string;
      extensions?: Record<string, unknown>;
      command?: Record<string, unknown>;
    }) => {
      manifest.platforms = ['codex'];
      manifest.skills = './skills';
      manifest.extensions = {
        agents: [{ name: 'reviewer', description: 'Synthetic Codex role.', prompt: 'Review carefully.\n' }],
      };
      manifest.command = {
        sourceDir: './commands',
        mode: 'static',
        routes: { subcommands: [{ name: 'ping', runner: 'node', entry: 'ping.mjs' }] },
      };
    };
    await timing.measure('fixture-step', 'catalog.build', async () => {
      await fs.outputFile(
        path.join(pluginRoot, 'skills', 'role-skill', 'SKILL.md'),
        '---\nname: role-skill\ndescription: Synthetic role skill.\n---\nUse reviewer.\n',
      );
      await fs.outputFile(path.join(pluginRoot, 'commands', 'ping.mjs'), 'export {};\n');
      await createCatalogSnapshotFixture(sourceRoot, pluginName, [], 'Synthetic role fixture\n', configureManifest);
      const snapshot = await readCatalogSourcesConfigSnapshot(env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
        expectedDigest: snapshot.digest,
        env,
      });
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const runPublic = async (args: string[]) => {
      const result = await runCliEntry([...args, '--json'], { cwd, env, interactive: false, nativeCliRunner: runtime.nativeCliRunner });
      return { exitCode: result.exitCode, payload: result.parseJsonStdout<Record<string, unknown>>() };
    };
    const roleNames = ['reviewer'];
    const projectRoles = roleNames.map((role) => path.join(cwd, '.codex', 'agents', `aw-team-${pluginName}-${role}.toml`));
    const userRoles = roleNames.map((role) => path.join(env.CODEX_HOME!, 'agents', `aw-team-${pluginName}-${role}.toml`));
    const projectInstall = await runPublic(['plugin', 'install', selector, '--scope', 'project', '--yes']);
    expect(projectInstall, JSON.stringify(projectInstall)).toMatchObject({ exitCode: 0, payload: { schemaVersion: 2, status: 'success' } });
    const cacheRoot = nativePackage(runtime, pluginName).root;
    const registrationId = nativePackage(runtime, pluginName).registrationId;
    for (const file of projectRoles) await expect(fs.pathExists(file)).resolves.toBe(true);
    const projectRoleBytes = await Promise.all(projectRoles.map((file) => fs.readFile(file)));
    const projectLocation = { scope: 'project' as const, cwd, env };
    const userLocation = { scope: 'user' as const, cwd, env };
    const projectIntentBefore = await observeIntent(projectLocation);
    const preferencesPath = await resolvePreferencesPath(userLocation);
    const preferencesBefore = await fs.readFile(preferencesPath);
    const foreignRole = path.join(cwd, '.codex', 'agents', 'foreign.toml');
    await fs.outputFile(foreignRole, 'developer_instructions = "foreign bytes"\n');
    const userInstall = await runPublic(['plugin', 'install', selector, '--scope', 'user', '--yes']);
    expect(userInstall, JSON.stringify(userInstall)).toMatchObject({ exitCode: 4, payload: { schemaVersion: 2, status: 'partial',
      data: { targetResults: expect.arrayContaining([expect.objectContaining({ pluginId: selector, scope: 'user', execution: 'applied' }),
        expect.objectContaining({ pluginId: selector, scope: 'project', deploymentReceipts: expect.arrayContaining([
          expect.objectContaining({ after: expect.objectContaining({ scopeActivation: 'unknown', registration: 'present' }) }),
        ]) })]) } } });
    for (const file of userRoles) await expect(fs.pathExists(file)).resolves.toBe(true);
    for (const [index, file] of projectRoles.entries()) {
      await expect(fs.readFile(file)).resolves.toEqual(projectRoleBytes[index]);
    }
    await expect(observeIntent(projectLocation)).resolves.toEqual(projectIntentBefore);
    const scopedStatus = await readRecoveryStatus({ cwd, env, cliVersion: '1.0.0', targets: ['codex'], nativeCliRunner: runtime.nativeCliRunner });
    expect(scopedStatus.inventory?.filter((entry) => entry.pluginId === selector)
      .flatMap((entry) => entry.targetResults), JSON.stringify(scopedStatus)).toContainEqual(expect.objectContaining({
        scope: 'project', providerScope: 'project', content: 'unknown', satisfaction: 'unknown', blockers: [],
        deploymentObservations: expect.arrayContaining([expect.objectContaining({ after: expect.objectContaining({
          scopeActivation: 'unknown', registration: 'present', consumers: [expect.objectContaining({ activation: 'enabled' })],
        }) })]),
      }));
    expect(scopedStatus.observedTargets?.flatMap((target) => [...target.blockers, ...target.reasons ?? []]).map((diagnostic) => diagnostic.code))
      .not.toContain('dynamicExpectationUnconfirmed');
    expect(scopedStatus.observedTargets?.flatMap((target) => [...target.blockers, ...target.reasons ?? []]).map((diagnostic) => diagnostic.code))
      .not.toContain('platformInputDrift');
    expect(scopedStatus.observedTargets?.flatMap((target) => target.deploymentObservations ?? [])
      .flatMap((observation) => observation.after?.components ?? []).flatMap((component) => component.reasonCodes))
      .not.toContain('componentOutputMissing');
    const userRoleBytes = await Promise.all(userRoles.map((file) => fs.readFile(file)));
    await fs.remove(userRoles[0]!);
    const drifted = await runPublic(['plugin', 'status', selector, '--context', 'user']);
    expect(drifted).toMatchObject({ exitCode: 0, payload: { status: 'success',
      data: { counts: { blocked: 0, pending: 1 }, inventory: [expect.objectContaining({
        targetResults: [expect.objectContaining({ content: 'absent', satisfaction: 'pending', blockerCodes: [] })],
      })] },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'componentOutputMissing', severity: 'warning',
        subject: { pluginId: selector, target: 'codex', scope: 'user' } })]),
      nextActions: expect.arrayContaining([expect.objectContaining({
        argv: ['aw', 'plugin', 'sync', selector, '--context', 'user', '--target', 'codex'],
      })]) } });
    expect(drifted.payload).not.toMatchObject({ diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'dynamicExpectationUnconfirmed' }),
    ]) });
    const userBeforeSync = await observeIntent(userLocation);
    const synced = await runPublic(['plugin', 'sync', selector, '--context', 'user', '--yes']);
    expect(synced, JSON.stringify(synced)).toMatchObject({ exitCode: 0, payload: { schemaVersion: 2, status: 'success' } });
    await expect(observeIntent(userLocation)).resolves.toEqual(userBeforeSync);
    await expect(observeIntent(projectLocation)).resolves.toEqual(projectIntentBefore);
    for (const [index, file] of userRoles.entries()) await expect(fs.readFile(file)).resolves.toEqual(userRoleBytes[index]);
    for (const [index, file] of projectRoles.entries()) await expect(fs.readFile(file)).resolves.toEqual(projectRoleBytes[index]);
    const { packages } = await listManagedCommandPackages(env);
    const installedCommand = packages.find((entry) => entry.selector === selector);
    expect(installedCommand?.resourceRoot).toBeDefined();
    await fs.writeFile(path.resolve(installedCommand!.resourceRoot!, '..', '..', 'current.json'), '{broken');
    const removed = await runPublic(['plugin', 'remove', selector, '--scope', 'user', '--yes']);
    expect(removed).toMatchObject({ exitCode: 4, payload: {
      status: 'partial', data: { changes: { requirements: 'changed' } },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'commandBindingInvalid' })]),
    } });
    await expect(observeIntent(projectLocation)).resolves.toEqual(projectIntentBefore);
    await expect(readFixtureRequirements(userLocation)).resolves.toMatchObject({ roots: [] });
    for (const [index, file] of projectRoles.entries()) await expect(fs.readFile(file)).resolves.toEqual(projectRoleBytes[index]);
    for (const file of userRoles) await expect(fs.pathExists(file)).resolves.toBe(false);
    expect((await readCodexConfigFile(path.join(cwd, '.codex', 'config.toml')))
      .snapshot.plugins[registrationId]?.enabled).toBe(true);
    await expect(fs.pathExists(path.join(cacheRoot, 'skills', 'role-skill', 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('developer_instructions = "foreign bytes"\n');
    await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
    const cleanup = (pluginId: string) => runPublic(['plugin', 'remove', '--only', 'outputs', pluginId,
      '--target', 'codex', '--scope', 'project', '--yes']);
    expect(await cleanup(selector)).toMatchObject({ exitCode: 4, payload: { schemaVersion: 2, status: 'partial',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'commandBindingInvalid' })]),
    } });
    for (const file of projectRoles) await expect(fs.pathExists(file)).resolves.toBe(false);
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('developer_instructions = "foreign bytes"\n');
    await expect(observeIntent(projectLocation)).resolves.toEqual(projectIntentBefore);
  }, 120_000);
});
