import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { prepareRun, prepareResume, executionConfiguration, validateCommandHost } from '../skills/codex-subagent-guide/scripts/runtime/runner.mjs';
import { selectExecution } from '../skills/codex-subagent-guide/scripts/runtime/plan.mjs';

const resourceRoot = fileURLToPath(new URL('../skills/codex-subagent-guide/', import.meta.url));

function select(command, request = {}) {
  return selectExecution({
    installedIdentity: { pluginName: 'codex-enhance' }, resourceRoot,
    effectiveValues: { subagentCommands: [{ key: 'selected', ...command }] },
  }, { executor: 'selected', ...request });
}

// Test Value Gate: observe the public execution plan consumed by the worker;
// omitted configuration must become explicit wire values without backend argv.
test('normalizes communication and Codex controls without changing backend args', () => {
  const defaults = select({ adapter: 'codex', args: ['--sandbox', 'workspace-write'] });
  assert.equal(defaults.communication, true);
  assert.deepEqual(defaults.codex, { cliSource: 'auto', bypassHookTrust: false });
  assert.deepEqual(defaults.executor.args, ['--sandbox', 'workspace-write']);
  for (const cliSource of ['auto', 'cli', 'app']) {
    for (const bypassHookTrust of [false, true]) {
      const plan = select({ adapter: 'codex', codexProfile: 'review',
        codexCliSource: cliSource, codexBypassHookTrust: bypassHookTrust, communication: false });
      assert.equal(plan.communication, false);
      assert.deepEqual(plan.codex, { cliSource, bypassHookTrust, profile: 'review' });
      assert.deepEqual(plan.executor.args, []);
    }
  }
  assert.deepEqual(select({ adapter: 'codex', codexBypassHookTrust: true,
    communication: false }).codex, { cliSource: 'auto', bypassHookTrust: true });
});

// Test Value Gate: a bundle continuation must use only the new message, while
// retaining its saved selectors for provenance and its original AW choices.
// This is request preparation, so it needs real paths but no worker or ACL run.
test('resume preparation preserves frozen choices and does not reselect bundle files', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-resume-plan-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const installedIdentity = { sourceId: 'fixture', sourceIdentity: 'fixture-source', pluginId: 'fixture/codex-enhance',
    pluginName: 'codex-enhance', platform: 'codex', scope: 'user', configScope: 'user', artifactId: 'guide', skillKey: 'codex-subagent-guide' };
  const snapshot = { installedIdentity, resourceRoot, effectiveValues: { subagentCommands: [{
    key: 'selected', adapter: 'custom', mode: 'bundle', command: await fs.realpath(process.execPath),
    args: ['original-option'], envFrom: { SERVICE_DATA: 'SOURCE' },
  }] } };
  const selected = selectExecution(snapshot, { executor: 'selected', model: 'original-model', reasoningEffort: 'original-effort' });
  const request = { prompt: 'Original task.', workspace: directory, files: ['original.txt'], deadlineMs: 20000 };
  const configuration = executionConfiguration(await prepareRun(selected, request, { environment: { SOURCE: 'old-value' } }), request);
  snapshot.effectiveValues.subagentCommands = [];
  const text = 'Only the new task.\r\n继续检查。\n';
  const prepared = await prepareResume(configuration, text, 'original-session', { runtimeSnapshot: snapshot, environment: { SOURCE: 'current-value' } });
  assert.equal(prepared.request.prompt, text);
  assert.equal(prepared.request.sessionId, 'original-session');
  assert.deepEqual(prepared.request.execution, { executor: 'selected', model: 'original-model', reasoningEffort: 'original-effort' });
  assert.deepEqual(prepared.request.args, ['original-option']);
  assert.equal(prepared.environment.SERVICE_DATA, 'current-value');
  assert.equal(Object.hasOwn(prepared.request, 'fileSelectors'), false);
  assert.equal(Object.hasOwn(prepared.request, 'fileResolver'), false);
  assert.deepEqual(configuration.request.fileSelectors, ['original.txt']);
  assert.equal(configuration.deadlineMs, 20000);
  assert.equal(Object.hasOwn(configuration, 'environment'), false);
  await assert.rejects(prepareResume(configuration, text, 'original-session', { runtimeSnapshot: snapshot, environment: {} }), { code: 'environmentSourceMissing' });
  await assert.rejects(prepareResume(configuration, text, 'original-session', {
    runtimeSnapshot: { ...snapshot, installedIdentity: { ...installedIdentity, sourceIdentity: 'foreign' } },
  }), { code: 'resumeExecutionChanged' });
});

// Test Value Gate: every supported branch has a fixed installed entrypoint or
// retains its custom command; Codex-only options cannot leak to another backend.
test('plans all adapters with independent communication and resume choices', () => {
  for (const adapter of ['codex', 'claude-code', 'antigravity', 'oracle', 'custom', 'custom-managed']) {
    const command = adapter === 'custom'
      ? { adapter, mode: 'workspace', command: process.execPath }
      : adapter === 'custom-managed' ? { adapter, mode: 'workspace', commandId: `cmdp_${'a'.repeat(16)}` } : { adapter };
    for (const communication of [undefined, false, true]) {
      for (const resume of [undefined, false, true]) {
        const plan = select({ ...command, ...(communication === undefined ? {} : { communication }), ...(resume === undefined ? {} : { resume }) });
        assert.equal(plan.communication, communication ?? true);
        assert.equal(plan.resume, resume ?? true);
        assert.deepEqual(plan.installedIdentity, { pluginName: 'codex-enhance' });
        assert.equal(plan.mode, adapter === 'oracle' ? 'bundle' : 'workspace');
        assert.equal(Object.hasOwn(plan, 'codex'), adapter === 'codex');
        if (adapter === 'antigravity') assert.equal(plan.entrypoint,
          path.join(resourceRoot, 'scripts/adapters/antigravity-v5.mjs'));
      }
    }
  }
});

// Test Value Gate: malformed installed controls must fail before spawning a
// backend, including foreign controls that might otherwise bypass trust checks.
test('rejects invalid controls and duplicate dedicated/raw Codex profiles', () => {
  const invalid = [
    ...['false', 0, null].map((communication) => ({ adapter: 'codex', communication })),
    ...['false', 0, null].map((resume) => ({ adapter: 'codex', resume })),
    ...['path', '', false, null].map((codexCliSource) => ({ adapter: 'codex', codexCliSource })),
    ...['false', 0, null].map((codexBypassHookTrust) => ({ adapter: 'codex', codexBypassHookTrust })),
    { adapter: 'antigravity', mode: 'bundle' },
    ...['claude-code', 'antigravity', 'oracle', 'custom'].flatMap((adapter) =>
      ['codexProfile', 'codexCliSource', 'codexBypassHookTrust'].map((key) => ({
        adapter, ...(adapter === 'custom' ? { command: process.execPath, mode: 'workspace' } : {}),
        [key]: key === 'codexBypassHookTrust' ? false : key === 'codexCliSource' ? 'auto' : 'review',
      }))),
  ];
  for (const command of invalid) assert.throws(() => select(command), { code: 'executorInvalid' });
  for (const args of [['--profile', 'raw'], ['--profile=raw'], ['-p', 'raw'], ['-praw']]) {
    assert.throws(() => select({ adapter: 'codex', codexProfile: 'selected', args }),
      { code: 'adapterArgumentConflict' });
    assert.deepEqual(select({ adapter: 'codex', args }).executor.args, args);
  }
});

// Test Value Gate: installed permissions must survive into the execution plan,
// independent of communication, without adding controls to unrelated adapters.
test('normalizes permission modes only for the supported backend branches', () => {
  for (const adapter of ['codex', 'claude-code', 'antigravity']) {
    assert.equal(select({ adapter }).permissionMode, 'default');
    for (const permissionMode of ['default', 'auto', 'full-access']) {
      for (const communication of [false, true]) {
        const plan = select({ adapter, permissionMode, communication });
        assert.equal(plan.permissionMode, permissionMode);
        assert.equal(plan.communication, communication);
        assert.deepEqual(plan.executor.args, []);
      }
    }
    for (const permissionMode of ['skip', '', false, null]) {
      assert.throws(() => select({ adapter, permissionMode }), { code: 'executorInvalid' });
    }
  }
  for (const adapter of ['oracle', 'custom']) {
    const command = { adapter, ...(adapter === 'custom' ? { mode: 'workspace', command: process.execPath } : {}) };
    assert.equal(Object.hasOwn(select(command), 'permissionMode'), false);
    for (const permissionMode of ['default', 'auto', 'full-access']) {
      assert.throws(() => select({ ...command, permissionMode }), { code: 'executorInvalid' });
    }
  }
});

// Test Value Gate: managed custom plans use exact IDs without accepting legacy
// paths or backend-specific controls; the original custom branch remains usable.
test('managed custom plans enforce command identity and protected environment fields', () => {
  const managed = { adapter: 'custom-managed', mode: 'workspace', commandId: 'cmdp_' + 'a'.repeat(16) };
  assert.equal(select(managed).executor.commandId, managed.commandId);
  assert.deepEqual(select({ ...managed, args: ['', '中文\nvalue'] }).executor.args, ['', '中文\nvalue']);
  for (const commandId of ['cmdp_' + 'A'.repeat(16), 'cmdp_short', 'cmdu_4ba70354-0867-4ecb-a927-120c1933f514x', 'other']) {
    assert.throws(() => select({ ...managed, commandId }), { code: 'executorInvalid' });
  }
  assert.equal(select({ ...managed, commandId: 'cmdu_4ba70354-0867-4ecb-a927-120c1933f514' }).mode, 'workspace');
  for (const extra of [{ command: process.execPath }, { entrypoint: '/tmp/entry.mjs' }, { permissionMode: 'default' }, { codexProfile: 'x' }, { oracleEngine: 'api' }]) {
    assert.throws(() => select({ ...managed, ...extra }), { code: 'executorInvalid' });
  }
  for (const name of ['AW_PLUGIN_FOO', 'aw_subagent_x', 'Aw_Command_Host', 'aw_agent_skill_eval_process_marker', 'aw_home', 'AW_CODEX_HOME', 'AW_CLAUDE_HOME']) {
    assert.throws(() => select({ ...managed, env: { [name]: 'x' } }), { code: 'environmentInvalid' });
    assert.throws(() => select({ ...managed, envFrom: { VALUE: name } }), { code: 'environmentInvalid' });
  }
  assert.throws(() => select({ ...managed, env: { VALUE: 'x' }, envFrom: { VALUE: 'SOURCE' } }), { code: 'environmentConflict' });
  assert.equal(select({ adapter: 'custom', mode: 'workspace', command: process.execPath, env: { AW_HOME: '/legacy', AW_COMMAND_VALUE: 'legacy' } }).executor.env.AW_HOME, '/legacy');
});

// Test Value Gate: the worker must invoke the same AW CLI with fixed argv,
// preserve executor args only in v5 JSON, and keep protected host data off wire.
test('managed host validation fixes nested AW argv and environment without exposing the descriptor', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-managed-guide-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const commandId = 'cmdu_4ba70354-0867-4ecb-a927-120c1933f514';
  const descriptor = { id: commandId, owner: { kind: 'user' }, resourceRoot: directory,
    availability: 'ready', launch: { runner: 'node', entry: 'adapter.mjs', args: [], env: {}, envFrom: {}, cwd: 'caller' } };
  const cliEntry = path.join(directory, 'aw cli 中文.mjs');
  await fs.writeFile(cliEntry, `process.stdout.write(JSON.stringify(${JSON.stringify({ schemaVersion: 1, command: 'command.show', ok: true, overallState: 'completed', commands: [descriptor] })}));`);
  const host = { schemaVersion: 1, nodeExecutable: process.execPath, cliEntry, awHome: directory };
  const environment = { AW_HOME: directory, AW_COMMAND_HOST: JSON.stringify(host), AW_COMMAND_OLD: 'old', AW_PLUGIN_CONTEXT: 'temporary', SOURCE: '', KEEP: 'original' };
  await assert.rejects(validateCommandHost({ AW_HOME: directory }), { code: 'managedCommandHostMissing' });
  for (const raw of ['{', '{}', JSON.stringify({ ...host, schemaVersion: 2 }), JSON.stringify({ ...host, awHome: '/different' }), JSON.stringify({ ...host, cliEntry: directory }), JSON.stringify({ ...host, nodeExecutable: directory }), JSON.stringify({ ...host, nodeExecutable: path.join(directory, 'missing-node') }), JSON.stringify({ ...host, unexpected: true })]) {
    await assert.rejects(validateCommandHost({ ...environment, AW_COMMAND_HOST: raw }), { code: 'managedCommandHostInvalid' });
  }
  // X_OK checks execution permissions on POSIX; Windows treats it as F_OK.
  if (process.platform !== 'win32') await assert.rejects(validateCommandHost({ ...environment, AW_COMMAND_HOST: JSON.stringify({ ...host, nodeExecutable: cliEntry }) }), { code: 'managedCommandHostInvalid' });
  const args = ['', '中文\nargument', '--option'];
  const plan = select({ adapter: 'custom-managed', mode: 'workspace', commandId, args, env: { KEEP: 'executor' }, envFrom: { EMPTY: 'SOURCE' } });
  const prepared = await prepareRun(plan, { prompt: ' task\n', workspace: directory }, { environment });
  assert.deepEqual(prepared.executable, { command: process.execPath, args: [cliEntry, 'command', 'run', commandId, '--'] });
  assert.deepEqual(prepared.request.args, args); assert.equal(prepared.request.prompt, ' task\n');
  assert.equal(prepared.environment.KEEP, 'executor'); assert.equal(prepared.environment.EMPTY, '');
  assert.equal(prepared.environment.AW_HOME, directory); assert.deepEqual(JSON.parse(prepared.environment.AW_COMMAND_HOST), host);
  assert.equal(prepared.environment.AW_COMMAND_OLD, undefined); assert.equal(prepared.environment.AW_PLUGIN_CONTEXT, undefined);
  assert.equal(JSON.stringify(prepared.request).includes('AW_COMMAND_HOST'), false); assert.equal(JSON.stringify(prepared.request).includes(cliEntry), false);
  await assert.rejects(prepareRun(select({ adapter: 'custom-managed', mode: 'workspace', commandId, envFrom: { EMPTY: 'MISSING' } }), { prompt: 'task', workspace: directory }, { environment }), { code: 'environmentSourceMissing' });
  const task = '\ufeff  task\n\n'; await fs.writeFile(path.join(directory, 'prompt.txt'), task);
  const otherWorkspace = path.join(directory, 'workspace'); await fs.mkdir(otherWorkspace);
  const input = await prepareRun(plan, { promptFile: 'prompt.txt', workspace: otherWorkspace }, { environment, callerCwd: directory });
  assert.equal(input.request.prompt, task); assert.equal(input.request.workspace, otherWorkspace);
});
