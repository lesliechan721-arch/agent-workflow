import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareRun, prepareResume, executionConfiguration } from '../skills/spawn-subagent/scripts/runtime/runner.mjs';
import { selectExecution } from '../skills/spawn-subagent/scripts/runtime/plan.mjs';
import { communicationCommand } from '../skills/spawn-subagent/scripts/runtime/managed-host.mjs';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';

const resourceRoot = path.dirname(guideRuntimeScripts(import.meta.url));
const commandId = 'cmdp_0123456789abcdef';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-communication-host-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const installedIdentity = { sourceId: 'one', sourceIdentity: 'source-one', pluginId: 'one/agent-subagent',
    pluginName: 'agent-subagent', pluginVersion: '1.0.0', platform: 'codex', scope: 'user', configScope: 'user',
    artifactId: 'spawn-subagent-skill', skillKey: 'spawn-subagent' };
  const producer = { sourceId: 'one', sourceIdentity: 'source-one', pluginName: 'agent-subagent',
    kind: 'artifact', key: installedIdentity.artifactId, platform: 'codex', scope: 'user', projectRoot: null };
  const target = { id: commandId, name: 'guide-communication/message/default', owner: { kind: 'plugin', producer },
    availability: 'ready', resourceRoot, launch: { runner: 'node', entry: 'scripts/message.mjs', args: [], env: {}, envFrom: {}, cwd: 'caller' }, errors: [], recoveryActions: [] };
  const stateFile = path.join(directory, 'commands.json'), capture = path.join(directory, 'calls.jsonl');
  const cliEntry = path.join(directory, 'aw.mjs');
  // Replace only the public AW boundary. Observe exact argv and protected home.
  await fs.writeFile(cliEntry, `import fs from 'node:fs/promises';
const args=process.argv.slice(2), state=JSON.parse(await fs.readFile(${JSON.stringify(stateFile)},'utf8'));
await fs.appendFile(${JSON.stringify(capture)},JSON.stringify({args,home:process.env.AW_HOME})+'\\n');
const list=args[1]==='list';
const commands=list?state.commands:state.commands.filter(c=>c.id===args[2]);
const partial=commands.some(c=>c.availability!=='ready');
process.stdout.write(JSON.stringify({schemaVersion:1,command:list?'command.list':'command.show',status:partial?'partial':'success',data:{commands,packages:[],changes:[]},diagnostics:[],nextActions:[]}));
process.exitCode=partial?4:0;`);
  const host = { schemaVersion: 1, nodeExecutable: process.execPath, cliEntry, awHome: directory };
  const environment = { AW_HOME: directory, AW_COMMAND_HOST: JSON.stringify(host), SOURCE_HOME: '/foreign' };
  const snapshot = { installedIdentity, resourceRoot, effectiveValues: { subagentCommands: [{ key: 'agy', adapter: 'antigravity',
    env: { AW_HOME: '/foreign', AW_COMMAND_HOST: '{}' }, envFrom: { ORDINARY: 'SOURCE_HOME' } }] } };
  const selected = () => selectExecution(snapshot, { executor: 'agy' });
  const save = (commands = [target]) => fs.writeFile(stateFile, JSON.stringify({ commands }));
  await save();
  return { directory, target, host, environment, snapshot, selected, save,
    calls: async () => (await fs.readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse),
    prepare: () => prepareRun(selected(), { prompt: 'task', workspace: directory }, { environment }) };
}

// Test Value Gate: real public CLI subprocesses protect source selection,
// partial-list handling and protected launch context before backend input.
test('communication selects the installed producer despite unrelated failures and freezes its host', async (t) => {
  const f = await fixture(t);
  const foreign = { ...f.target, id: 'cmdp_aaaaaaaaaaaaaaaa', owner: { kind: 'plugin', producer: { ...f.target.owner.producer, sourceIdentity: 'source-two' } } };
  const other = { ...f.target, id: 'cmdp_bbbbbbbbbbbbbbbb', owner: { kind: 'plugin', producer: { ...f.target.owner.producer, key: 'other-skill' } } };
  await f.save([foreign, other, { ...foreign, id: 'cmdp_cccccccccccccccc', availability: 'unavailable' }, f.target]);
  const prepared = await f.prepare();
  assert.equal(prepared.communicationLaunch.id, commandId);
  assert.deepEqual(prepared.commandHost, f.host);
  assert.equal(prepared.environment.AW_HOME, f.directory);
  assert.equal(prepared.environment.ORDINARY, '/foreign');
  assert.deepEqual(await communicationCommand(prepared.environment), { command: process.execPath,
    args: [f.host.cliEntry, 'command', 'run', commandId, '--'] });
  assert.deepEqual(await f.calls(), [
    { args: ['command', 'list', '--json'], home: f.directory },
    { args: ['command', 'show', commandId, '--json'], home: f.directory },
  ]);
  assert.equal(JSON.stringify(prepared.request).includes(f.host.cliEntry), false);
  assert.equal(Object.hasOwn(prepared.request, 'communicationLaunch'), false);
});

test('communication refuses missing, ambiguous, foreign and changed launches without a fallback', async (t) => {
  const f = await fixture(t);
  for (const commands of [[], [f.target, f.target],
    [{ ...f.target, availability: 'unavailable' }],
    [{ ...f.target, owner: { kind: 'plugin', producer: { ...f.target.owner.producer, sourceId: 'two' } } }],
    [{ ...f.target, owner: { kind: 'plugin', producer: { ...f.target.owner.producer, scope: 'project', projectRoot: f.directory } } }],
    [{ ...f.target, resourceRoot: f.directory }],
    [{ ...f.target, launch: { ...f.target.launch, entry: 'scripts/subagent.mjs' } }],
    [{ ...f.target, launch: { ...f.target.launch, args: ['start'] } }],
  ]) {
    await f.save(commands);
    await assert.rejects(f.prepare(), { code: 'managedCommandUnavailable' });
  }
  await assert.rejects(prepareRun(f.selected(), { prompt: 'task', workspace: f.directory }, { environment: {} }), { code: 'managedCommandHostMissing' });
  await assert.rejects(prepareRun(f.selected(), { prompt: 'task', workspace: f.directory }, { environment: { ...f.environment, AW_HOME: '/other-home' } }), { code: 'managedCommandHostInvalid' });
});

test('communication resume rechecks the original host, source, resource and exact command binding', async (t) => {
  const f = await fixture(t), prepared = await f.prepare();
  const configuration = executionConfiguration(prepared, {});
  const options = { runtimeSnapshot: f.snapshot, environment: f.environment };
  const resumed = await prepareResume(configuration, 'next task', 'same-session', options);
  assert.equal(resumed.request.sessionId, 'same-session');
  assert.equal(resumed.request.prompt, 'next task');
  assert.deepEqual(resumed.communicationLaunch, prepared.communicationLaunch);
  assert.deepEqual(resumed.environment, prepared.environment);
  await f.save([{ ...f.target, id: 'cmdp_ffffffffffffffff' }]);
  await assert.rejects(prepareResume(configuration, 'next', 'same-session', options), { code: 'resumeExecutionChanged' });
  await assert.rejects(prepareResume(configuration, 'next', 'same-session', { ...options,
    runtimeSnapshot: { ...f.snapshot, installedIdentity: { ...f.snapshot.installedIdentity, sourceIdentity: 'source-two' } } }), { code: 'resumeExecutionChanged' });
  await fs.unlink(f.host.cliEntry);
  await assert.rejects(prepareResume(configuration, 'next', 'same-session', options), { code: 'managedCommandHostInvalid' });
});

test('communication=false does not require a host or inspect managed commands', async (t) => {
  const f = await fixture(t);
  f.snapshot.effectiveValues.subagentCommands[0].communication = false;
  const prepared = await prepareRun(f.selected(), { prompt: 'task', workspace: f.directory }, { environment: { SOURCE_HOME: '' } });
  assert.equal(prepared.communicationLaunch, undefined);
  assert.equal(prepared.commandHost, undefined);
  assert.equal(prepared.environment.AW_SUBAGENT_COMMUNICATION_COMMAND, undefined);
  await assert.rejects(f.calls(), { code: 'ENOENT' });
});

// Test Value Gate: the extracted runtime must reject old-plugin or unsupported-host
// producers before inspecting commands, even if the command owner matches them.
test('communication accepts only the new Codex producer identity', async (t) => {
  const f = await fixture(t);
  for (const replacement of [
    { pluginName: 'codex-enhance' }, { skillKey: 'codex-subagent-guide' },
    { artifactId: 'codex-subagent-guide-skill' }, { platform: 'claude', artifactId: 'spawn-subagent-claude-skill' },
  ]) {
    const changed = { ...f.snapshot, installedIdentity: { ...f.snapshot.installedIdentity, ...replacement } };
    const selected = selectExecution(changed, { executor: 'agy' });
    await assert.rejects(prepareRun(selected, { prompt: 'task', workspace: f.directory },
      { environment: f.environment }), { code: 'managedCommandUnavailable' });
  }
  await assert.rejects(fs.readFile(path.join(f.directory, 'calls.jsonl')), { code: 'ENOENT' });
});
