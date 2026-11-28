import { beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { runCli } from '../../src/index.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { PassThrough } from 'node:stream';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getNativeTestLayout, installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import {
  readCatalogSourcesConfigSnapshot,
} from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  readPluginConfigStore,
  resolvePluginConfigStorePath,
  setAtomicConfigBeforeRenameHookForTests,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { createCapturedCliIo, createTtyRuntimeStreams } from '../helpers/cli-entry.js';
import type { CommandEvent } from '../../src/output/model.js';
import {
  replaceCatalogSourcesConfig,
  readCatalogLogicalIdentity,
  createCodexNativeTestRuntime,
} from '../helpers/write-command-fixture.js';

async function prepareManualSkillConfigFixture(test: TestContext) {
  const timing = createCommandTestTiming(test);
  const { env, layout: { fixtureCwd: cwd } } = getCurrentSourceTestIsolation();
  const source = path.join(cwd, 'manual-skill-config-source');
  await timing.measure('fixture', 'manual-skill-catalog', async () => {
    await fs.outputFile(path.join(source, 'plugins/demo/render.mjs'), `import fs from 'node:fs';
const { config: { values: { mode } }, allowedOutputKinds } = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));
if (!allowedOutputKinds.includes('skill')) {
  console.log(JSON.stringify({ version: 3, components: [], omitted: [], unmet: [] })); process.exit(0);
}
const skill = (name, policy) => ({ id: name, kind: 'skill', name, content: { files: {
  'SKILL.md': { text: '---\\nname: ' + name + '\\ndescription: Fixture skill.\\n' + policy + '---\\nMode: ' + mode + '\\n' },
  'README.md': { text: 'Fixture skill.\\n' }
} } });
const manual = skill('manual', 'user-invocable: true\\ndisable-model-invocation: true\\n');
const gap = { id: 'ordinary', kind: 'skill', name: 'ordinary', reasonCode: 'interface-unsupported',
  requiredFeatures: [{ feature: 'skill.execution', values: ['isolated-context'] }] };
const partial = mode === 'partial';
console.log(JSON.stringify({ version: 3, omitted: [], unmet: partial ? [gap] : [],
  components: partial ? [manual] : [skill('ordinary', ''), manual] }));
`);
    await createCatalogSnapshotFixture(source, 'demo', [], 'Fixture plugin.\n', (manifest) => {
      manifest.platforms = ['generic'];
      manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'safe' } } };
      manifest.artifacts = { configKeys: ['mode'] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    });
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: source }] },
    expectedDigest: (await readCatalogSourcesConfigSnapshot(env)).digest, env });
    await writePreferences({ scope: 'user', cwd, env }, {
      ...createEmptyPreferences(), targets: ['generic'],
    });
  });
  const runJson = (args: string[], onEvent?: (event: CommandEvent) => void) =>
    timing.measure('command', args.slice(0, args[1] === 'config' ? 3 : 2).join(' '), async (sequence) => {
      const output = createCapturedCliIo();
      const exitCode = await runCli([...args, '--json'], {
        cwd, env, io: output.io, interactive: false,
        debugLogger: { log(event) {
          timing.commandEvent(sequence, event);
          onEvent?.(event);
        } },
      });
      return { exitCode, payload: JSON.parse(output.readStdout()) };
    });
  const invocationNotice = {
    code: 'skillInvocationPolicyNotGuaranteed', severity: 'warning',
    subject: { pluginId: 'team/demo', target: 'generic', scope: 'user', field: 'skill.manual' },
    detail: { reasonCode: 'noBoundExecutor', skillInvocationControls: expect.arrayContaining([
      { feature: 'skill.invocation.model', values: ['false'], reasonCode: 'noBoundExecutor' },
    ]) },
  };
  const invocationNotices = (result: Awaited<ReturnType<typeof runJson>>) =>
    result.payload.diagnostics.filter(({ code }: { code: string }) => code === invocationNotice.code);
  const skillPath = path.join(env.HOME!, '.agents', 'skills', 'manual', 'SKILL.md');
  const install = (scope: 'user' | 'project') =>
    runJson(['plugin', 'install', 'team/demo', '--scope', scope, '--context', scope, '--target', 'generic', '--yes']);
  return { cwd, skillPath, install, runJson, invocationNotice, invocationNotices };
}

describe('five namespaced write commands', () => {
  beforeEach(async () => {
    installNativeTestDiscovery({ platforms: ['codex', 'claude'] });
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  // Test Value Gate: a final signal must preserve a real Skill repair and its verified receipt.
  it('keeps the verified generic Skill repair when configuration apply receives a final signal', async (test) => {
    const { cwd, skillPath, install, runJson, invocationNotice } = await prepareManualSkillConfigFixture(test);
    const installed = await install('user');
    expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0, payload: { status: 'success', diagnostics: [invocationNotice] } });
    const original = await fs.readFile(skillPath);
    await fs.move(path.dirname(skillPath), path.join(cwd, 'moved-manual-skill'));
    let interruptedAfterStatus = false;
    const applied = await runJson(['plugin', 'config', 'apply', 'demo', '--context', 'user', '--target', 'generic', '--yes'], (event) => {
      if (!interruptedAfterStatus && event.type === 'performance:stage'
        && event.data?.name === 'recovery.status' && event.data.phase === 'success') {
        interruptedAfterStatus = true;
        process.emit('SIGINT', 'SIGINT');
      }
    });
    expect(interruptedAfterStatus).toBe(true);
    expect(applied).toMatchObject({ exitCode: 130, payload: { status: 'success',
      data: { plugin: 'demo', pluginId: 'team/demo', sourceId: 'team', context: { context: 'user' },
        configWrite: 'notStarted', confirmation: { required: false, provided: true, effects: [] },
        apply: { state: 'succeeded', targetResults: [{
          target: { pluginId: 'team/demo', platform: 'generic', scope: 'user' }, state: 'completed',
        }] } },
      diagnostics: expect.arrayContaining([expect.objectContaining(invocationNotice),
        expect.objectContaining({ code: 'operationInterrupted' })]) } });
    expect(await fs.readFile(skillPath)).toEqual(original);
  }, 30_000);

  // Test Value Gate: config changes must report delivered Skills and preserve a sibling when only part of a target can refresh.
  it('reports invocation limits for Skills delivered by config changes and partial apply', async (test) => {
    const { cwd, skillPath, install, runJson, invocationNotice, invocationNotices } = await prepareManualSkillConfigFixture(test);
    const installed = await install('user');
    expect(installed).toMatchObject({ exitCode: 0, payload: { status: 'success', diagnostics: [invocationNotice] } });
    const setArgs = ['plugin', 'config', 'set', 'team/demo', 'mode', '--context', 'user', '--value-json', '"fast"', '--platform', 'generic', '--apply', '--yes'];
    const set = await runJson(setArgs);
    expect(await fs.readFile(skillPath, 'utf8')).toContain('Mode: fast');
    expect(set).toMatchObject({ exitCode: 0, payload: { status: 'success',
      data: { configWrite: 'succeeded', apply: { state: 'succeeded' } } } });
    expect(invocationNotices(set)).toMatchObject([invocationNotice]);
    const unchanged = await runJson(setArgs);
    expect(unchanged).toMatchObject({ exitCode: 0, payload: {
      status: 'success', data: { apply: { state: 'skipped', reason: 'noConfigChange' } },
    } });
    expect(invocationNotices(unchanged)).toEqual([]);

    expect(await install('project')).toMatchObject({ exitCode: 0, payload: { status: 'success' } });
    const projectSkill = path.join(cwd, '.agents', 'skills', 'manual', 'SKILL.md');
    const projectBefore = await fs.readFile(projectSkill);
    expect(projectBefore).toEqual(await fs.readFile(skillPath));
    const saveOnly = await runJson(['plugin', 'config', 'set', 'team/demo', 'mode', '--context', 'user',
      '--value-json', '"partial"', '--platform', 'generic']);
    expect(saveOnly).toMatchObject({ exitCode: 0, payload: { data: { apply: { state: 'skipped', reason: 'notRequested' } } } });
    expect(invocationNotices(saveOnly)).toEqual([]);
    expect(await fs.readFile(skillPath, 'utf8')).toContain('Mode: fast');
    const ordinaryPath = path.join(path.dirname(path.dirname(skillPath)), 'ordinary', 'SKILL.md');
    const retainedDirectory = path.dirname(ordinaryPath);
    const ordinary = await fs.readFile(ordinaryPath);
    const partial = await runJson(['plugin', 'config', 'apply', 'team/demo', '--context', 'user', '--target', 'generic', '--yes']);
    expect(partial).toMatchObject({ exitCode: 4, payload: {
      status: 'partial',
      data: { configWrite: 'notStarted', apply: { state: 'partial', targetResults: [{
        target: { pluginId: 'team/demo', platform: 'generic', scope: 'user' },
        state: 'failed', partialDelivery: true, errorCode: 'previousDeploymentRetained',
      }] } },
      diagnostics: expect.arrayContaining([expect.objectContaining({
        code: 'previousDeploymentRetained',
        subject: { pluginId: 'team/demo', target: 'generic', scope: 'user', field: 'skill.ordinary' },
        detail: expect.objectContaining({ path: retainedDirectory }),
      })]),
    } });
    expect(partial.payload.nextActions).toContainEqual({ kind: 'manual', message: expect.stringContaining(JSON.stringify(retainedDirectory)) });
    expect(partial.payload.nextActions).toContainEqual({ kind: 'manual', message: expect.stringContaining('team/demo (generic/user)') });
    expect(partial.payload.nextActions).not.toContainEqual(expect.objectContaining({ kind: 'command' }));
    expect(invocationNotices(partial), JSON.stringify(partial)).toMatchObject([invocationNotice]);
    expect(await fs.readFile(skillPath, 'utf8')).toContain('Mode: partial');
    expect(await fs.readFile(ordinaryPath)).toEqual(ordinary);
    expect(await fs.readFile(projectSkill)).toEqual(projectBefore);
  }, 30_000);

  // Test Value Gate: the same Skill has separate delivery and warning evidence for each real scope.
  it('keeps User and Project Skill delivery separate during configuration apply', async (test) => {
    const { cwd, skillPath, install, runJson, invocationNotice, invocationNotices } = await prepareManualSkillConfigFixture(test);
    const projectSkill = path.join(cwd, '.agents', 'skills', 'manual', 'SKILL.md');
    const projectNotice = { ...invocationNotice, subject: { ...invocationNotice.subject, scope: 'project' } };
    expect(await install('user')).toMatchObject({ exitCode: 0, payload: { status: 'success' } });
    const projectInstall = await install('project');
    expect(projectInstall).toMatchObject({ exitCode: 0, payload: { status: 'success' } });
    expect(invocationNotices(projectInstall)).toMatchObject([projectNotice]);
    const current = await fs.readFile(skillPath);
    expect(await fs.readFile(projectSkill)).toEqual(current);
    await fs.remove(path.dirname(skillPath));
    await fs.remove(path.dirname(projectSkill));
    const userApply = await runJson(['plugin', 'config', 'apply', 'team/demo', '--context', 'user', '--target', 'generic', '--yes']);
    expect(userApply).toMatchObject({ exitCode: 0, payload: { status: 'success' } });
    expect(invocationNotices(userApply)).toMatchObject([invocationNotice]);
    expect(await fs.readFile(skillPath)).toEqual(current);
    expect(await fs.pathExists(projectSkill)).toBe(false);

    await fs.remove(path.dirname(skillPath));
    const jointApply = await runJson(['plugin', 'config', 'apply', 'team/demo', '--context', 'project', '--target', 'generic', '--yes']);
    expect(jointApply).toMatchObject({ exitCode: 0, payload: { status: 'success' } });
    expect(invocationNotices(jointApply)).toHaveLength(2);
    expect(invocationNotices(jointApply)).toEqual(expect.arrayContaining([
      expect.objectContaining(invocationNotice), expect.objectContaining(projectNotice),
    ]));
    expect(await fs.readFile(skillPath)).toEqual(current);
    expect(await fs.readFile(projectSkill)).toEqual(current);
  }, 30_000);

  it('keeps sensitive config input out of argv and preserves stdin bytes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'sensitive-config-input-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = { fields: { token: { type: 'string', sensitive: true } } };
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    const readStore = () => readPluginConfigStore({
      sourceId: 'team', sourceIdentity, logicalIdentity,
      pluginName: 'demo', scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const runJson = async (args: string[], stdin?: PassThrough) => {
      const captured = createCapturedCliIo();
      const exitCode = await runCli([...args, '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
        ...(stdin ? { stdin } : {}),
      });
      return { exitCode, stdout: captured.readStdout(), stderr: captured.readStderr() };
    };

    for (const args of [
      ['--value-json', 'argv-secret'],
      ['--preset', 'argv-secret'],
    ]) {
      const rejected = await runJson([
        'plugin', 'config', 'set', 'team/demo', 'token', '--context', 'user', ...args,
      ]);
      expect(rejected.exitCode).toBe(2);
      expect(rejected.stdout).not.toContain('argv-secret');
      expect(rejected.stderr).not.toContain('argv-secret');
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        schemaVersion: 2, command: 'plugin.config.set', status: 'failed', data: {},
        diagnostics: [{ code: 'sensitiveConfigInputUnsupported' }],
      });
    }

    const missing = await runJson([
      'plugin', 'config', 'set', 'team/demo', 'token', '--context', 'user',
    ]);
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      schemaVersion: 2, command: 'plugin.config.set', status: 'failed', data: {},
      diagnostics: [{ code: 'invalidArguments' }],
    });

    const stdin = new PassThrough();
    stdin.end('stdin-secret\nwith-newline\n');
    const written = await runJson([
      'plugin', 'config', 'set', 'team/demo', 'token', '--context', 'user', '--value-stdin',
    ], stdin);
    expect(written.exitCode).toBe(0);
    await expect(readStore()).resolves.toMatchObject({
      values: { token: 'stdin-secret\nwith-newline\n' },
    });
    const configFile = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env
    });
    const bytesBeforeMissingInput = await fs.readFile(configFile);

    const password = vi.fn(async () => ({
      action: 'select' as const,
      cancelled: false,
      value: 'hidden-prompt-secret',
    }));
    const captured = createCapturedCliIo();
    const exitCode = await runCli([
      'plugin', 'config', 'set', 'team/demo', 'token', '--context', 'user',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: true,
      prompt: { password },
      ...createTtyRuntimeStreams(),
    });
    expect(exitCode).toBe(2);
    expect(password).not.toHaveBeenCalled();
    expect(captured.readStdout()).not.toContain('hidden-prompt-secret');
    expect(captured.readStderr()).not.toContain('hidden-prompt-secret');
    await expect(readStore()).resolves.toMatchObject({ values: { token: 'stdin-secret\nwith-newline\n' } });
    expect(await fs.readFile(configFile)).toEqual(bytesBeforeMissingInput);
  });

  it('prints an executable stdin-only repair command for invalid sensitive config', async () => {
    const isolation = getCurrentSourceTestIsolation();
    // Keep the invalid token distinct from hexadecimal source identity digests.
    const invalidToken = 'x!?';
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'sensitive-config-repair-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = {
        fields: {
          token: {
            type: 'string', required: true, sensitive: true,
            validation: { minLength: 5 },
          },
        },
      };
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity: await calculateCatalogSourceIdentity(source),
      logicalIdentity: await readCatalogLogicalIdentity(sourceRoot),
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { token: invalidToken },
    });
    const output = createCapturedCliIo();

    const exitCode = await runCli([
      'plugin', 'config', 'get', 'team/demo', '--context', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: output.io,
      interactive: false,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.readStdout())).toMatchObject({
      schemaVersion: 2, command: 'plugin.config.get', status: 'success',
      nextActions: expect.arrayContaining([expect.objectContaining({
        kind: 'command',
        argv: ['aw', 'plugin', 'config', 'set', 'team/demo', 'token', '--context', 'user', '--value-stdin'],
        requiresConfirmation: false
      })])
    });
    expect(output.readStdout()).not.toContain(invalidToken);
    expect(output.readStdout()).not.toContain('--value-json');
    expect(output.readStdout()).not.toContain('--preset');
    // Both formats must use the same safe action and preserve the selected profile.
    for (const platform of [undefined, 'codex']) {
      const profileArgs = platform ? ['--platform', platform] : [];
      const expectedArgv = ['aw', 'plugin', 'config', 'set', 'team/demo', 'token', '--context', 'project', ...profileArgs, '--value-stdin'];
      for (const json of [false, true]) {
        const captured = createCapturedCliIo();
        expect(await runCli(['plugin', 'config', 'get', 'team/demo', '--context', 'project', ...profileArgs, ...(json ? ['--json'] : [])], {
          cwd: isolation.layout.fixtureCwd, env: isolation.env, io: captured.io, interactive: false,
        })).toBe(0);
        const stdout = captured.readStdout();
        if (json) expect(JSON.parse(stdout).nextActions).toContainEqual(expect.objectContaining({ kind: 'command', argv: expectedArgv, requiresConfirmation: false }));
        else expect(stdout).toContain(`Next: ${expectedArgv.join(' ')}`);
        for (const forbidden of [invalidToken, '--value-json', '--preset', '--apply', '--yes']) expect(stdout).not.toContain(forbidden);
      }
    }
  });

  it('sets and unsets whole platform arrays, rejects v5 bytes, and recreates v6 after reset', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
      { ...createEmptyPreferences(), targets: ['cursor'] });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'array-config-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = {
        schemaVersion: 5,
        fields: {
          labels: { type: 'array', items: { type: 'string' } },
          counts: { type: 'array', items: { type: 'number' } },
          flags: { type: 'array', items: { type: 'boolean' } },
        },
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const run = async (args: string[]) => {
      const output = createCapturedCliIo();
      const exitCode = await runCli([...args, '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: output.io,
        interactive: false,
      });
      return { exitCode, payload: JSON.parse(output.readStdout()) as Record<string, unknown> };
    };
    const userPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const projectPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'demo', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    expect(projectPath).toBe(userPath);

    expect(await run(['plugin', 'config', 'set', 'team/demo', 'labels', '--context', 'user',
      '--value-json', '["user",""]'])).toMatchObject({
        exitCode: 0, payload: { schemaVersion: 2, status: 'success', data: { configWrite: 'succeeded' }, },
      });
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'counts', '--context', 'user',
      '--value-json', '[0,2]'])).toMatchObject({ exitCode: 0 });
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'flags', '--context', 'user',
      '--value-json', '[false,true]'])).toMatchObject({ exitCode: 0 });
    expect(await fs.readJson(userPath)).toMatchObject({
      schemaVersion: 6,
      common: { labels: ['user', ''], counts: [0, 2], flags: [false, true] },
    });
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'labels', '--context', 'project', '--platform', 'cursor',
      '--value-json', '[]'])).toMatchObject({
        exitCode: 0, payload: { schemaVersion: 2, status: 'success', data: { configWrite: 'succeeded' }, },
      });
    expect(await fs.readJson(userPath)).toMatchObject({ schemaVersion: 6,
      common: { labels: ['user', ''], counts: [0, 2], flags: [false, true] }, platforms: { cursor: { labels: [] } } });
    expect(await run(['plugin', 'config', 'get', 'team/demo', 'labels', '--platform', 'cursor'])).toMatchObject({
      exitCode: 0,
      payload: { schemaVersion: 2, status: 'success', data: { fields: [expect.objectContaining({ effectiveValue: [], sourceLayer: 'platform' })] }, },
    });
    expect(await run(['plugin', 'config', 'unset', 'team/demo', 'labels', '--context', 'project', '--platform', 'cursor'])).toMatchObject({
      exitCode: 0, payload: { schemaVersion: 2, status: 'success', data: { configWrite: 'succeeded' }, },
    });
    expect(await run(['plugin', 'config', 'get', 'team/demo', 'labels', '--platform', 'cursor'])).toMatchObject({
      exitCode: 0,
      payload: { schemaVersion: 2, status: 'success', data: { fields: [expect.objectContaining({ effectiveValue: ['user', ''], sourceLayer: 'common' })] }, },
    });

    const validBytes = await fs.readFile(userPath, 'utf8');
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'labels', '--context', 'user',
      '--value-json', '["mixed",0]'])).toMatchObject({ exitCode: 2 });
    expect(await fs.readFile(userPath, 'utf8')).toBe(validBytes);

    const stored = await fs.readJson(userPath) as Record<string, unknown>;
    const oldBytes = `${JSON.stringify({ ...stored, schemaVersion: 5 })}\n`;
    await fs.writeFile(userPath, oldBytes);
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'labels', '--context', 'user',
      '--value-json', '["changed"]'])).toMatchObject({
        exitCode: 1,
        payload: { schemaVersion: 2, status: 'failed', diagnostics: [expect.objectContaining({ code: 'schemaVersionUnsupported' })] },
      });
    expect(await fs.readFile(userPath, 'utf8')).toBe(oldBytes);
    expect(await run(['plugin', 'config', 'reset', 'team/demo', '--context', 'user', '--yes']))
      .toMatchObject({ exitCode: 0 });
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'labels', '--context', 'user',
      '--value-json', '["changed"]'])).toMatchObject({ exitCode: 0 });
    expect(await fs.readJson(userPath)).toMatchObject({
      schemaVersion: 6, common: { labels: ['changed'] },
    });
  });

  describe('namespaced config replay', () => {
    async function createFixture(test: TestContext) {
      const timing = createCommandTestTiming(test);
      const isolation = getCurrentSourceTestIsolation();
      await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
        { ...createEmptyPreferences(), targets: ['codex'] });
      const sourceRoot = path.join(isolation.layout.fixtureCwd, 'config-replay-source');
      await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'), [
        'import { readFile } from "node:fs/promises";',
        'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
        'const mode = context.config.values.mode ?? "safe";',
        'if (mode === "fail") {',
        '  console.error("file:///C:/Users/RUNNER%7E1/AppData/Local/Temp/private-renderer/render.mjs:4:28");',
        '  throw new Error("renderer requested failure");',
        '}',
        'console.log(JSON.stringify({version:3,components:context.allowedOutputKinds.includes("instruction")?[{id:"instruction",name:"instruction",kind:"instruction",content:{title:"Config",content:`mode=${mode}`,coverage:["main"]}}]:[],omitted:[],unmet:[]}));',
      ].join('\n'));
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.config = {
          schemaVersion: 5,
          fields: {
            mode: {
              type: 'string',
              default: 'safe',
              choices: {
                allowCustom: true,
                presets: [{ id: 'safe', title: 'Safe', value: 'safe' }],
              },
            },
            labels: {
              type: 'object',
              additionalProperties: { type: 'string' },
              validation: { key: { format: 'identifier' } },
            },
          },
        };
        manifest.scripts = {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        };
        manifest.artifacts = { configKeys: ['mode'], scopes: ['user'] };
        manifest.platforms = ['codex'];
      });
      const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
      const before = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [source] },
        expectedDigest: before.digest,
        env: isolation.env,
      });
      const { nativeCliRunner } = await createCodexNativeTestRuntime(isolation);
      const runPublic = (args: string[]) => timing.measure(
        'command',
        args[1] === 'config' ? `plugin config ${args[2]}` : `plugin ${args[1]}`,
        async () => {
          const captured = createCapturedCliIo();
          const exitCode = await runCli([...args, '--json'], {
            cwd: isolation.layout.fixtureCwd,
            env: isolation.env,
            io: captured.io,
            interactive: false,
            nativeCliRunner,
          });
          return {
            exitCode,
            stdout: captured.readStdout(),
            payload: JSON.parse(captured.readStdout()) as Record<string, unknown>,
            stderr: captured.readStderr(),
          };
        },
      );
      const store = {
        sourceId: 'team',
        sourceIdentity,
        logicalIdentity,
        pluginName: 'demo',
        scope: 'user' as const,
        platform: 'codex' as const,
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      };
      const readStore = () => readPluginConfigStore(store);
      const layout = await getNativeTestLayout({ platform: 'codex', pluginId: 'team/demo', sourceIdentity, cwd: isolation.layout.fixtureCwd, env: isolation.env });
      const configPath = path.join(layout.packageRoot, 'scripts', 'aw-instructions.mjs');
      const runHumanConfig = async (args: string[]) => timing.measure('command', `human config ${args[2]}`, async () => {
        const output = createCapturedCliIo();
        const exitCode = await runCli(args, {
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
          io: output.io,
          interactive: false,
          nativeCliRunner,
        });
        return { exitCode, stdout: output.readStdout(), stderr: output.readStderr() };
      });
      return { isolation, nativeCliRunner, runPublic, runHumanConfig, readStore, configPath, store };
    }

    // Test Value Gate: config writes refresh existing output; missing output remains absent until explicit sync.
    // Keep the eight-command state chain intact with a Windows completion window.
    it('replays presets, unset and reset while requiring sync for missing output', async (test) => {
      const { isolation, nativeCliRunner, runPublic, readStore, configPath, store } = await createFixture(test);
      expect(await runPublic([
        'plugin', 'install', 'team/demo', '--scope', 'project', '--yes',
      ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 2, status: 'success', } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      const sourceOnlyPreset = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--preset', 'safe', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(sourceOnlyPreset).toMatchObject({
        exitCode: 0,
        payload: { schemaVersion: 2, status: 'success', data: { updatedKeys: ['mode'], apply: { state: 'succeeded' } }, },
      });
      const equivalentPreset = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--preset', 'safe', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(equivalentPreset).toMatchObject({
        exitCode: 0,
        payload: { schemaVersion: 2, status: 'success', data: { updatedKeys: [], apply: { state: 'skipped', reason: 'noConfigChange' } }, },
      });

      await fs.remove(path.dirname(path.dirname(configPath)));
      const missing = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, env: isolation.env,
        nativeCliRunner, context: 'project', targets: ['codex'] });
      expect(missing.observedTargets).toEqual(expect.arrayContaining([expect.objectContaining({
        pluginId: 'team/demo', agent: 'codex', scope: 'project', content: 'unknown', observation: 'unknown',
        blockers: [],
        reasons: expect.arrayContaining([expect.objectContaining({ code: 'dynamicExpectationUnconfirmed' })]),
        deploymentObservations: expect.arrayContaining([expect.objectContaining({
          after: expect.objectContaining({ package: 'absent', ownership: 'absent', registration: 'present' }),
        })]),
      })]));

      const set = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(set, JSON.stringify(set)).toMatchObject({
        exitCode: 4,
        payload: {
          schemaVersion: 2, status: 'partial', data: {
            configWrite: 'succeeded', apply: {
              state: 'partial', targetResults: [expect.objectContaining({
                target: expect.objectContaining({ pluginId: 'team/demo', platform: 'codex', scope: 'project' }),
                state: 'skipped', errorCode: 'configApplyRequiresExistingOutput',
              })]
            }
          },
        },
      });
      expect(set.payload).not.toHaveProperty('targetResults');
      expect(JSON.parse(set.stdout)).toEqual(set.payload);
      expect(JSON.stringify(set.payload)).not.toContain('projectConfigShareabilityUnverified');
      expect(await fs.readJson(resolvePluginConfigStorePath({
        sourceId: 'team', pluginName: 'demo', scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      }))).toMatchObject({ schemaVersion: 6, common: {}, platforms: { codex: { mode: 'fast' } } });
      expect((await readStore()).values).toEqual({ mode: 'fast' });
      await expect(fs.pathExists(configPath)).resolves.toBe(false);
      expect(await runPublic(['plugin', 'sync', 'team/demo', '--target', 'codex', '--context', 'project', '--yes']))
        .toMatchObject({ exitCode: 0, payload: { schemaVersion: 2, status: 'success', } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=fast');

      const unset = await runPublic([
        'plugin', 'config', 'unset', 'team/demo', 'mode', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(unset).toMatchObject({
        exitCode: 0,
        payload: { schemaVersion: 2, status: 'success', data: { configWrite: 'succeeded' }, },
      });
      expect((await readStore()).values).toEqual({});
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      await writePluginConfigStore({ ...store, values: { mode: 'fast' } });
      expect(await runPublic(['plugin', 'sync', 'team/demo', '--target', 'codex', '--context', 'project', '--yes']))
        .toMatchObject({ exitCode: 0, payload: { schemaVersion: 2, status: 'success', } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=fast');
      const reset = await runPublic([
        'plugin', 'config', 'reset', 'team/demo', '--context', 'project', '--platform', 'codex', '--yes', '--apply',
      ]);
      expect(reset).toMatchObject({
        exitCode: 0,
        payload: { schemaVersion: 2, status: 'success', data: { configWrite: 'succeeded', deleted: true }, },
      });
      expect((await readStore()).exists).toBe(false);
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');
    }, process.platform === 'win32' ? 60_000 : 30_000);

    // Test Value Gate: CLI save notices and atomic failure receipts must agree with the stored values.
    it('saves without apply and preserves the previous store on atomic failure', async (test) => {
      const { runPublic, runHumanConfig, readStore, configPath, store } = await createFixture(test);
      const human = await runHumanConfig([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--context', 'project', '--platform', 'codex',
      ]);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain('configWrite: succeeded');
      expect(human.stdout).toContain('Apply: skipped (notRequested)');
      expect(human.stderr).not.toContain('projectConfigShareabilityUnverified');
      expect((await readStore()).values).toEqual({ mode: 'fast' });
      await expect(fs.pathExists(configPath)).resolves.toBe(false);

      const userSet = await runHumanConfig([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"user-fast"', '--context', 'user',
      ]);
      const userUnset = await runHumanConfig([
        'plugin', 'config', 'unset', 'team/demo', 'mode', '--context', 'user',
      ]);
      await writePluginConfigStore({ ...store, platform: undefined, values: { mode: 'user-reset' } });
      const userReset = await runHumanConfig([
        'plugin', 'config', 'reset', 'team/demo', '--context', 'user', '--yes',
      ]);
      for (const result of [userSet, userUnset, userReset]) {
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('scope: user');
        expect(result.stdout + result.stderr).not.toMatch(/[\u3400-\u9fff]/u);
      }

      setAtomicConfigBeforeRenameHookForTests(async () => {
        throw new Error('injected config commit failure');
      });
      let atomicFailure;
      try {
        atomicFailure = await runPublic([
          'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"safe"', '--context', 'project', '--platform', 'codex',
        ]);
      } finally {
        setAtomicConfigBeforeRenameHookForTests(undefined);
      }
      expect(atomicFailure).toMatchObject({
        exitCode: 1,
        payload: { schemaVersion: 2, status: 'failed', data: { configWrite: 'failed' }, },
      });
      expect((await readStore()).values).toEqual({ mode: 'fast' });
    }, 30_000);

    // Test Value Gate: invalid configuration remains repairable without overwriting valid output or unrelated fields.
    it('removes stale keys and repairs invalid fields without refreshing unrelated output', async (test) => {
      const { runPublic, runHumanConfig, readStore, configPath, store } = await createFixture(test);
      expect(await runPublic(['plugin', 'install', 'team/demo', '--scope', 'project', '--yes']))
        .toMatchObject({ exitCode: 0, payload: { schemaVersion: 2, status: 'success', } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      await writePluginConfigStore({
        ...store,
        values: { obsolete: 'old' },
      });
      const staleUnset = await runPublic([
        'plugin', 'config', 'unset', 'team/demo', 'obsolete', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(staleUnset).toMatchObject({
        exitCode: 0,
        payload: { schemaVersion: 2, status: 'success', data: { configWrite: 'succeeded', staleRemovedKeys: ['obsolete'], affectedFields: [expect.objectContaining({ key: 'obsolete', stale: true })], apply: { state: 'skipped', reason: 'noEffectiveConfigChange', targetResults: [] } }, },
      });
      expect(staleUnset.payload).not.toHaveProperty('targetResults');
      expect((await readStore()).values).toEqual({});
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      await writePluginConfigStore({
        ...store,
        values: { labels: { 'bad key': 'preserved' } },
      });
      const partial = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(partial, JSON.stringify(partial)).toMatchObject({
        exitCode: 4,
        payload: {
          schemaVersion: 2, status: 'partial', data: {
            configWrite: 'succeeded', apply: {
              state: 'partial',
              targetResults: [expect.objectContaining({ state: 'skipped', errorCode: 'invalidConfig' })],
            }, effective: {
              fieldStates: {
                labels: { invalidOverride: { source: 'platform' } },
                mode: { effective: { source: 'platform', value: 'fast' } },
              },
            }
          },
        },
      });
      expect((await readStore()).values).toEqual({
        labels: { 'bad key': 'preserved' },
        mode: 'fast',
      });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      const unavailableHuman = await runHumanConfig([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"slow"', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(unavailableHuman).toMatchObject({ exitCode: 4 });
      expect(unavailableHuman.stdout).toContain('configWrite: succeeded');
      expect(unavailableHuman.stdout).toContain('codex/project: skipped');
      expect(unavailableHuman.stderr).toContain('invalidConfig');
      expect(unavailableHuman.stdout).toContain(
        'aw plugin sync team/demo --context project --target codex',
      );
      expect(unavailableHuman.stderr).not.toContain('preserved');

      const repaired = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'labels', '--value-json', '{"good_key":"repaired"}',
        '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(repaired).toMatchObject({
        exitCode: 0,
        payload: { schemaVersion: 2, status: 'success', data: { configWrite: 'succeeded', apply: { state: 'skipped', reason: 'noEffectiveConfigChange' } }, },
      });
      expect((await readStore()).values).toEqual({
        labels: { good_key: 'repaired' },
        mode: 'slow',
      });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');
    }, 30_000);

    // Test Value Gate: a real renderer failure preserves the committed store and previous output, with safe recovery guidance.
    it('keeps saved config and previous output when rendering fails', async (test) => {
      const { runPublic, runHumanConfig, readStore, configPath, store } = await createFixture(test);
      await writePluginConfigStore({ ...store, values: { labels: { good_key: 'repaired' }, mode: 'fast' } });
      expect(await runPublic(['plugin', 'install', 'team/demo', '--scope', 'project', '--yes']))
        .toMatchObject({ exitCode: 0, payload: { schemaVersion: 2, status: 'success', } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=fast');

      const failed = await runHumanConfig([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"fail"', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(failed).toMatchObject({ exitCode: 4 });
      expect(failed.stdout).toContain('codex/project: failed');
      expect(failed.stderr).toContain('writeFailed');
      expect(failed.stdout).toContain(
        'aw plugin sync team/demo --context project --target codex',
      );
      expect(failed.stderr).not.toContain('file:///');
      expect((await readStore()).values).toEqual({
        labels: { good_key: 'repaired' },
        mode: 'fail',
      });
      const configAfterFailure = await fs.readFile(configPath, 'utf8');
      expect(configAfterFailure).toContain('mode=fast');
      expect(configAfterFailure).not.toContain('mode=fail');
    }, 30_000);
  });
});
