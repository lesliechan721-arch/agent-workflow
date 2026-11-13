import { describe, beforeEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { resolvePreferencesPath, writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { parseCodexRoleFile } from '../../src/utils/codex-roles.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';
import { listManagedCommands } from '../../src/utils/managed-command-store.js';
import {
  AW_RUNTIME_CONFIG_BINDING_PATH,
  preparePluginNativeTools,
  type RuntimeConfigBinding,
} from '@lesliechan721/aw-plugin-core';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import { readPluginConfigStore } from '../../src/utils/plugin-config.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import { SKILL_OWNER_MARKER, type SkillOwnerMarker } from '../../src/utils/ownership.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';

import {
  installWriteCommand,
  readFixtureRequirements,
  prepareCodexEnhancePublicCommandFixture,
} from '../helpers/write-command-fixture.js';

function nativePackage(runtime: { packageRoots: Map<string, string> }, name: string) {
  const matches = [...runtime.packageRoots].filter(([id]) => id.startsWith(`${name}@`));
  expect(matches).toHaveLength(1);
  const [registrationId, root] = matches[0]!;
  return { registrationId, root };
}

describe('five namespaced write commands', () => {
  beforeEach(async () => {
    installNativeTestQualification({ platforms: ['codex'], discovery: true, trust: true });
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  it('runs the publicly installed Guide cmdp entry through AW into a fake v5 managed adapter', async () => {
    // Test Value Gate: one real public installation closes generated Skill/permission IDs, AW wrapping, and a live fake v5 backend.
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const { isolation, runtime, runPublic } = await prepareCodexEnhancePublicCommandFixture();
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const runtimeSourceRoot = path.join(isolation.layout.fixtureCwd, 'guide-runtime-source');
    await fs.copy(path.join(repositoryRoot, 'plugins/agent-subagent'), runtimeSourceRoot);
    await preparePluginNativeTools(runtimeSourceRoot, (await readPluginManifest(runtimeSourceRoot)).manifest);
    const helpers = await import(pathToFileURL(path.join(runtimeSourceRoot, 'scripts/fixtures/subagent-integration.mjs')).href);
    const { openRun, storeContext } = await import(pathToFileURL(path.join(
      runtimeSourceRoot, 'skills/spawn-subagent/scripts/runtime/store.mjs',
    )).href);
    const cleanups: Array<() => Promise<void>> = [() => fs.remove(runtimeSourceRoot)];
    const fixture = await helpers.fixture({ signal: new AbortController().signal, diagnostic: () => {}, after: (cleanup: () => Promise<void>) => { cleanups.push(cleanup); } });
    const cliEntry = path.join(repositoryRoot, 'packages/cli/dist/index.js');
    const scenario = path.join(fixture.directory, 'public-managed-scenario');
    await fs.ensureDir(scenario);
    await fs.writeJson(path.join(scenario, 'scenario.json'), { echo: true, finalText: 'Public Guide final result.', adapterLifetimeMs: 60000, backendLifetimeMs: 60000 });
    const environment = {
      ...isolation.env,
      HOME: fixture.homeRoot,
      USERPROFILE: fixture.homeRoot,
      TMPDIR: fixture.temporaryRoot,
      TMP: fixture.temporaryRoot,
      TEMP: fixture.temporaryRoot,
      FIXTURE_SCENARIO_FILE: path.join(scenario, 'scenario.json'),
      FIXTURE_RUN_DIRECTORY: scenario,
      FIXTURE_GENERATIONS: fixture.generations,
    };
    const invokeGuide = (id: string, args: string[]) => new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cliEntry, 'command', 'run', id, '--', ...args], { cwd: fixture.workspace, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Public managed Guide command timed out.')); }, 30000);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
    });
    let guideId: string | undefined, run: string | undefined;
    try {
      const adapterSource = path.join(isolation.layout.fixtureCwd, 'public-adapter');
      await fs.ensureDir(adapterSource);
      await fs.copyFile(path.join(fixture.directory, 'fake-adapter.mjs'), path.join(adapterSource, 'adapter.mjs'));
      const adapter = await runPublic(['command', 'install', adapterSource, '--name', 'public-v5-adapter', '--runner', 'node', '--entry', 'adapter.mjs', '--args-json', '["fixed-argv"]', '--yes']);
      expect(adapter.exitCode).toBe(0);
      const adapterId = (adapter.payload.data as { commands: Array<{ id: string }> }).commands[0]!.id;
      expect(await runPublic(['plugin', 'config', 'set', 'team/agent-subagent', 'subagentCommands', '--context', 'user', '--value-json', JSON.stringify([{ key: 'fixture', adapter: 'custom-managed', mode: 'workspace', commandId: adapterId, args: ['v5-request-only'] }])])).toMatchObject({ exitCode: 0 });
      const preview = await installWriteCommand(['team/agent-subagent'], { cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project' }, { ...runtime, previewOperationPlan: true });
      const review = buildOperationReviewProjection({ intent: { kind: 'pluginWrite', action: 'install', pluginId: 'team/agent-subagent', platform: 'codex', scope: 'project' }, evidence: { catalog: { configDigest: 'fixture', compositeDigest: 'fixture' }, operationPlan: preview.operationPlan } });
      expect(review.changes).toContainEqual(expect.objectContaining({ title: 'guide/subagent/default', description: expect.stringContaining('node · scripts/subagent.mjs') }));
      const installed = await runPublic(['plugin', 'install', 'team/agent-subagent', '--scope', 'project', '--yes']);
      expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success' } });
      const guideCommand = (await listManagedCommands(isolation.env)).commands.find((command) => command.name === 'guide/subagent/default')!;
      expect(guideCommand.owner).toMatchObject({ kind: 'plugin', producer: {
        pluginName: 'agent-subagent', kind: 'artifact', key: 'spawn-subagent-skill',
      } });
      guideId = guideCommand.id;
      expect(guideId).toMatch(/^cmdp_[0-9a-f]{16}$/u);
      expect(review.changes).toContainEqual(expect.objectContaining({ title: expect.stringMatching(/^Codex 权限规则/u), description: expect.stringContaining(guideId) }));
      const permission = await fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex/rules/aw-team-agent-subagent-subagent-commands.rules'), 'utf8');
      expect(permission).toContain(JSON.stringify(['aw', 'command', 'run', guideId, '--', 'start']));
      await fs.writeFile(path.join(fixture.workspace, 'prompt.txt'), 'Public installation task.\n');
      const started = await invokeGuide(guideId, ['start', '--executor', 'fixture', '--workspace', fixture.workspace, '--prompt-file', 'prompt.txt']);
      run = helpers.field(started.stdout, 'run');
      expect(started, JSON.stringify(started)).toMatchObject({ exitCode: 0, stderr: '' });
      expect(started.stdout).toMatch(/^started \S+ communication=true resume=false\n$/u);
      const observed = await helpers.eventually(async () => fs.readJson(path.join(scenario, 'observed.json')), 'public installed Guide backend');
      process.kill(observed.pid, 0);
      expect(observed.argv).toEqual(['fixed-argv']);
      expect(observed.request.args).toEqual(['v5-request-only']);
      expect(observed.request.prompt).toBe('Public installation task.\n');
      expect(observed.request.resume).toBe(true);
      const sent = await invokeGuide(guideId, ['send', '--run', run!, '--text', 'Continue.']);
      expect(sent).toMatchObject({ exitCode: 0, stdout: `queued ${run}\n` });
      await helpers.eventually(async () => (await fs.readFile(path.join(scenario, 'inputs.jsonl'), 'utf8')).includes('Continue.'), 'public wrapped worker still alive after start');
      await fs.writeFile(path.join(scenario, 'finish'), '');
      const deadline = Date.now() + 10000;
      let final: Awaited<ReturnType<typeof invokeGuide>>;
      do {
        final = await invokeGuide(guideId, ['wait', '--run', run!, '--timeout-ms', String(Math.max(0, deadline - Date.now()))]);
        expect(final).toMatchObject({ exitCode: 0 });
      } while (!helpers.terminalPattern.test(final.stdout) && Date.now() < deadline);
      expect(final.stdout).toContain('Public Guide final result.');
    } finally {
      try {
        if (guideId && run) {
          const stopped = await invokeGuide(guideId, ['stop', '--run', run]);
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

  it('cleans codex-enhance project roles when its shared command binding is missing', async (test) => {
    // Missing weak command state must not block cleanup of exact scoped output.
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const timing = createCommandTestTiming(test);
    const { isolation, runtime, runPublic } = await timing.measure(
      'fixture', 'codex-enhance', () => prepareCodexEnhancePublicCommandFixture(timing),
    );
    expect(await runPublic([
      'plugin', 'install', 'team/codex-enhance', '--scope', 'project', '--yes'])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success' } });
    // Each plugin has two shared package batches and one project Agent batch.
    // Lock rechecks and manager resolution must reuse these successful inputs.
    expect(timing.rendererCalls).toBe(6);
    const enhanceRegistrationId = nativePackage(runtime, 'codex-enhance').registrationId;
    const subagentCacheRoot = nativePackage(runtime, 'agent-subagent').root;
    const guideCommand = (await listManagedCommands(isolation.env)).commands
      .find((command) => command.name === 'guide/subagent/default')!;
    await fs.remove(path.join(isolation.env.AW_HOME!, 'commands', 'bindings', `${guideCommand.id}.json`));
    const intentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const intentBefore = await fs.readFile(intentPath);

    expect(await runPublic([
      'plugin', 'remove', '--only', 'outputs', 'team/codex-enhance', '--target', 'codex', '--scope', 'project', '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success' } });
    expect(timing.rendererCalls).toBe(6);
    for (const role of ['codex-explore', 'codex-advisor']) {
      await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'agents',
        `aw-team-codex-enhance-${role}.toml`))).resolves.toBe(false);
    }
    expect((await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .snapshot.plugins[enhanceRegistrationId]?.enabled).not.toBe(true);
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    await expect(fs.pathExists(path.join(subagentCacheRoot, 'skills', 'spawn-subagent', 'SKILL.md')))
      .resolves.toBe(true);
  }, 30_000);

  it('rematerializes codex-enhance shared Skills without changing project roles through public commands', async (test) => {
    // Test Value Gate: real config writes rematerialize only affected shared Skills and bindings, while project roles keep their bytes and scope.
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const timing = createCommandTestTiming(test);
    const { isolation, sourceIdentity, logicalIdentity, runtime, runPublic } =
      await timing.measure('fixture', 'codex-enhance', () => prepareCodexEnhancePublicCommandFixture(timing));
    const roleKeys = ['codex-explore', 'codex-advisor'];
    const assertRoleInstructions = (roleKey: string, delivered: string | undefined, shared: string) => {
      if (typeof delivered !== 'string') throw new Error('Expected native role developer instructions.');
      if (roleKey === 'subagent') {
        expect(delivered).toBe(shared);
        return;
      }
      const prefix = `${shared.trimEnd()}\n\n`;
      expect(delivered.startsWith(prefix)).toBe(true);
      const local = delivered.slice(prefix.length);
      // Check the native developer-channel scope; this does not prove model compliance.
      expect(local.split(roleKey)).toHaveLength(2);
      const task = roleKey === 'codex-advisor' ? '咨询' : '调查';
      expect(local).toContain(`不要通过 ${roleKey} 将同一${task}重新委派`);
      expect(local).toContain(`只限制重复父级${task}编排`);
      expect(local).toContain('不禁止为不同有界子目标采用本次任务允许的协作方法');
      for (const other of ['codex-advisor', 'codex-explore'].filter((key) => key !== roleKey)) {
        expect(local).not.toContain(other);
      }
    };
    expect(await runPublic([
      'plugin', 'config', 'set', 'team/codex-enhance', 'standardProfile', '--context', 'project',
      '--value-json', '{"model":"project-standard","reasoningEffort":"max"}',
    ])).toMatchObject({ exitCode: 0 });
    expect(await runPublic([
      'plugin', 'config', 'set', 'team/codex-enhance', 'standardProfile', '--context', 'user',
      '--value-json', '{"model":"user-standard","reasoningEffort":"max"}',
    ])).toMatchObject({
      exitCode: 0,
      payload: { status: 'success', data: { apply: { state: 'skipped', reason: 'notRequested', targetResults: [] } } },
    });
    const projectInstall = await runPublic([
      'plugin', 'install', 'team/codex-enhance', '--scope', 'project', '--yes']);
    expect(projectInstall, JSON.stringify(projectInstall, null, 2))
      .toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success' } });
    const cacheRoot = nativePackage(runtime, 'codex-enhance').root;
    const enhanceRegistrationId = nativePackage(runtime, 'codex-enhance').registrationId;
    const subagentCacheRoot = nativePackage(runtime, 'agent-subagent').root;
    const skillKeys = ['codex-explore', 'codex-advisor'];
    const skillPaths = skillKeys.map((skill) =>
      path.join(cacheRoot, 'skills', skill, 'SKILL.md'));
    for (const skillPath of skillPaths) await expect(fs.pathExists(skillPath)).resolves.toBe(true);
    for (const skill of skillKeys) {
      await expect(fs.pathExists(path.join(isolation.env.CODEX_HOME!, 'skills', skill)))
        .resolves.toBe(false);
    }
    const initialSkillBytes = await Promise.all(skillPaths.map((skillPath) => fs.readFile(skillPath)));
    const guideBindingPath = path.join(
      subagentCacheRoot, 'skills', 'spawn-subagent', AW_RUNTIME_CONFIG_BINDING_PATH,
    );
    const initialBinding = await fs.readJson(guideBindingPath) as RuntimeConfigBinding;
    expect(initialBinding).toMatchObject({
      schemaVersion: 2,
      installedIdentity: { pluginName: 'agent-subagent', skillKey: 'spawn-subagent', scope: 'user', configScope: 'user' },
      allowedKeys: ['subagentCommands', 'subagentRetentionHours'],
    });
    expect(initialBinding.effectiveValues).toEqual({ subagentCommands: [], subagentRetentionHours: 24 });
    for (const skill of ['codex-explore', 'codex-advisor']) {
      await expect(fs.pathExists(path.join(cacheRoot, 'skills', skill, AW_RUNTIME_CONFIG_BINDING_PATH)))
        .resolves.toBe(false);
    }
    const initialReceipt = await fs.readJson(
      path.join(cacheRoot, SKILL_OWNER_MARKER),
    ) as SkillOwnerMarker;
    expect(initialReceipt.nativeProjection?.components.filter((component) => component.relativeOutputs.some((file) => file.endsWith('/SKILL.md')))
      .map((component) => component.nativeName).sort()).toEqual([
      'codex-advisor', 'codex-explore',
    ]);
    const userStore = await readPluginConfigStore({
      sourceId: 'team', sourceIdentity, logicalIdentity,
      pluginName: 'codex-enhance', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    expect(userStore.values.standardProfile).toEqual({
      model: 'user-standard', reasoningEffort: 'max',
    });
    const rolePaths = roleKeys.map((role) => path.join(
      isolation.layout.fixtureCwd, '.codex', 'agents', `aw-team-codex-enhance-${role}.toml`,
    ));
    const initialRoleBytes = await Promise.all(rolePaths.map((file) => fs.readFile(file, 'utf8')));
    const instructionFiles = ['explore-instructions.md', 'advisor-instructions.md'];
    for (const [index, content] of initialRoleBytes.entries()) {
      const role = parseCodexRoleFile(content);
      expect(role.model).toBeUndefined();
      expect(role.modelReasoningEffort).toBeUndefined();
      const sharedInstructions = await fs.readFile(path.join(
        cacheRoot, 'skills', skillKeys[index]!, 'assets', instructionFiles[index]!,
      ), 'utf8');
      assertRoleInstructions(roleKeys[index]!, role.developerInstructions, sharedInstructions);
    }
    const subagentRolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-team-agent-subagent-subagent.toml');
    const initialSubagentRoleBytes = await fs.readFile(subagentRolePath, 'utf8');
    const installedSubagentRole = parseCodexRoleFile(initialSubagentRoleBytes);
    expect(installedSubagentRole.model).toBeUndefined();
    expect(installedSubagentRole.modelReasoningEffort).toBeUndefined();
    assertRoleInstructions('subagent', installedSubagentRole.developerInstructions,
      await fs.readFile(path.join(subagentCacheRoot, 'skills/spawn-subagent/assets/task-instructions.md'), 'utf8'));
    expect(initialSkillBytes[0].toString('utf8')).toContain('"user-standard"');
    expect(initialSkillBytes[1].toString('utf8')).not.toContain('"user-standard"');
    expect(await runPublic([
      'plugin', 'config', 'set', 'team/codex-enhance', 'standardProfile', '--context', 'user',
      '--value-json', '{"model":"saved-standard","reasoningEffort":"medium"}',
    ])).toMatchObject({
      exitCode: 0,
      payload: { status: 'success', data: { apply: { state: 'skipped', reason: 'notRequested' } } },
    });
    await expect(fs.readJson(guideBindingPath)).resolves.toEqual(initialBinding);
    for (const [index, file] of skillPaths.entries()) {
      await expect(fs.readFile(file)).resolves.toEqual(initialSkillBytes[index]);
    }
    const rematerialized = await runPublic([
      'plugin', 'config', 'set', 'team/codex-enhance', 'standardProfile', '--context', 'project',
      '--value-json', '{"model":"updated-standard","reasoningEffort":"high"}',
      '--apply', '--yes',
    ]);
    expect(rematerialized, JSON.stringify(rematerialized)).toMatchObject({ exitCode: 0 });
    await expect(fs.readFile(skillPaths[0], 'utf8')).resolves.toContain('"updated-standard"');
    await expect(fs.readFile(skillPaths[0]!)).resolves.not.toEqual(initialSkillBytes[0]);
    for (const index of [1]) {
      await expect(fs.readFile(skillPaths[index]!)).resolves.toEqual(initialSkillBytes[index]);
    }
    const updatedBinding = await fs.readJson(guideBindingPath) as RuntimeConfigBinding;
    expect(updatedBinding).toEqual(initialBinding);
    for (const [index, file] of rolePaths.entries()) {
      await expect(fs.readFile(file, 'utf8')).resolves.toBe(initialRoleBytes[index]);
    }
    await expect(fs.readFile(subagentRolePath, 'utf8')).resolves.toBe(initialSubagentRoleBytes);
    const projectOnlyConfig = await readCodexConfigFile(path.join(
      isolation.layout.fixtureCwd, '.codex', 'config.toml',
    ));
    const projectOnlyUserConfig = await readCodexConfigFile(path.join(
      isolation.env.CODEX_HOME!, 'config.toml',
    ));
    expect(projectOnlyConfig.snapshot.plugins[enhanceRegistrationId]?.enabled).toBe(true);
    expect(projectOnlyUserConfig.snapshot.plugins[enhanceRegistrationId]?.enabled).not.toBe(true);
    const guideCommand = (await listManagedCommands(isolation.env)).commands.find((command) => command.name === 'guide/subagent/default')!;
    await fs.remove(path.join(isolation.env.AW_HOME!, 'commands', 'bindings', `${guideCommand.id}.json`));
    expect(await runPublic([
      'plugin', 'remove', '--only', 'outputs', 'team/codex-enhance', '--target', 'codex', '--scope', 'project', '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success' } });
    for (const file of rolePaths) await expect(fs.pathExists(file)).resolves.toBe(false);
    await expect(fs.pathExists(subagentRolePath)).resolves.toBe(true);
    expect(await runPublic([
      'plugin', 'remove', '--only', 'outputs', 'team/agent-subagent', '--target', 'codex', '--scope', 'project', '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success' } });
    await expect(fs.pathExists(subagentRolePath)).resolves.toBe(false);
    expect((await readCodexConfigFile(path.join(
      isolation.layout.fixtureCwd, '.codex', 'config.toml',
    ))).snapshot.plugins[enhanceRegistrationId]?.enabled).not.toBe(true);
  }, 120_000);

  it('preserves codex-enhance project roles while adding and removing the user root through public commands', async (test) => {
    // Test Value Gate: shared package activation cannot move or remove independent scoped Agent output.
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const timing = createCommandTestTiming(test);
    const { isolation, runtime, runPublic } = await timing.measure(
      'fixture', 'codex-enhance', () => prepareCodexEnhancePublicCommandFixture(timing),
    );
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const roleNames = ['codex-explore', 'codex-advisor'];
    const projectRoles = roleNames.map((role) => path.join(cwd, '.codex', 'agents', `aw-team-codex-enhance-${role}.toml`));
    const userRoles = roleNames.map((role) => path.join(env.CODEX_HOME!, 'agents', `aw-team-codex-enhance-${role}.toml`));
    const projectInstall = await runPublic(['plugin', 'install', 'team/codex-enhance', '--scope', 'project', '--yes']);
    expect(projectInstall, JSON.stringify(projectInstall)).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success' } });
    const cacheRoot = nativePackage(runtime, 'codex-enhance').root;
    const enhanceRegistrationId = nativePackage(runtime, 'codex-enhance').registrationId;
    for (const file of projectRoles) await expect(fs.pathExists(file)).resolves.toBe(true);
    const projectRoleBytes = await Promise.all(projectRoles.map((file) => fs.readFile(file)));
    const projectLocation = { scope: 'project' as const, cwd, env };
    const userLocation = { scope: 'user' as const, cwd, env };
    const projectIntentBefore = await observeIntent(projectLocation);
    const preferencesPath = await resolvePreferencesPath(userLocation);
    const preferencesBefore = await fs.readFile(preferencesPath);
    const foreignRole = path.join(cwd, '.codex', 'agents', 'foreign.toml');
    await fs.outputFile(foreignRole, 'developer_instructions = "foreign bytes"\n');
    const userInstall = await runPublic(['plugin', 'install', 'team/codex-enhance', '--scope', 'user', '--yes']);
    expect(userInstall, JSON.stringify(userInstall)).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success' } });
    for (const file of userRoles) await expect(fs.pathExists(file)).resolves.toBe(true);
    for (const [index, file] of projectRoles.entries()) {
      await expect(fs.readFile(file)).resolves.toEqual(projectRoleBytes[index]);
    }
    await expect(observeIntent(projectLocation)).resolves.toEqual(projectIntentBefore);
    const scopedStatus = await readRecoveryStatus({ cwd, env, cliVersion: '1.0.0', targets: ['codex'], nativeCliRunner: runtime.nativeCliRunner });
    expect(scopedStatus.inventory?.filter((entry) => entry.pluginId === 'team/codex-enhance')
      .flatMap((entry) => entry.targetResults), JSON.stringify(scopedStatus)).toContainEqual(expect.objectContaining({
        scope: 'project', providerScope: 'project', content: 'unknown', satisfaction: 'unknown',
        blockers: expect.arrayContaining([expect.objectContaining({ code: 'dynamicExpectationUnconfirmed' })]),
      }));
    // Read-only status cannot recreate the dynamic supplement collection. The
    // concrete files above are verified separately without claiming host loading.
    expect(scopedStatus.observedTargets?.flatMap((target) => target.blockers).map((blocker) => blocker.code))
      .not.toContain('platformInputDrift');
    expect(scopedStatus.observedTargets?.flatMap((target) => target.deploymentObservations ?? [])
      .flatMap((observation) => observation.after?.components ?? []).flatMap((component) => component.reasonCodes))
      .not.toContain('componentOutputMissing');
    const userBeforeSync = await observeIntent(userLocation);
    const userRoleBytes = await Promise.all(userRoles.map((file) => fs.readFile(file)));
    const synced = await runPublic(['plugin', 'sync', 'team/codex-enhance', '--context', 'project', '--yes']);
    expect(synced, JSON.stringify(synced)).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success' } });
    await expect(observeIntent(userLocation)).resolves.toEqual(userBeforeSync);
    await expect(observeIntent(projectLocation)).resolves.toEqual(projectIntentBefore);
    for (const [index, file] of userRoles.entries()) await expect(fs.readFile(file)).resolves.toEqual(userRoleBytes[index]);
    for (const [index, file] of projectRoles.entries()) await expect(fs.readFile(file)).resolves.toEqual(projectRoleBytes[index]);
    const guideCommand = (await listManagedCommands(env)).commands.find((command) => command.name === 'guide/subagent/default')!;
    await fs.writeFile(path.join(env.AW_HOME!, 'commands', 'bindings', `${guideCommand.id}.json`), '{broken');
    const removed = await runPublic(['plugin', 'remove', 'team/codex-enhance', '--scope', 'user', '--yes']);
    expect(removed, JSON.stringify(removed)).toMatchObject({ exitCode: 0, payload: {
      status: 'success', data: { changes: { requirements: 'changed' } },
    } });
    await expect(observeIntent(projectLocation)).resolves.toEqual(projectIntentBefore);
    await expect(readFixtureRequirements(userLocation)).resolves.toMatchObject({ roots: [] });
    for (const [index, file] of projectRoles.entries()) await expect(fs.readFile(file)).resolves.toEqual(projectRoleBytes[index]);
    for (const file of userRoles) await expect(fs.pathExists(file)).resolves.toBe(false);
    expect((await readCodexConfigFile(path.join(cwd, '.codex', 'config.toml')))
      .snapshot.plugins[enhanceRegistrationId]?.enabled).toBe(true);
    await expect(fs.pathExists(path.join(cacheRoot, 'skills', 'codex-explore', 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('developer_instructions = "foreign bytes"\n');
    await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
    for (const pluginId of ['team/codex-enhance', 'team/agent-subagent']) {
      const cleaned = await runPublic(['plugin', 'remove', '--only', 'outputs', pluginId, '--target', 'codex', '--scope', 'project', '--yes']);
      expect(cleaned, JSON.stringify(cleaned)).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success' } });
    }
    for (const file of projectRoles) await expect(fs.pathExists(file)).resolves.toBe(false);
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('developer_instructions = "foreign bytes"\n');
    await expect(observeIntent(projectLocation)).resolves.toEqual(projectIntentBefore);
  }, 120_000);
});
