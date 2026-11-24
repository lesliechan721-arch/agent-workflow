import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareRun, prepareResume, executionConfiguration } from '../commands/scripts/runtime/runner.mjs';
import { selectExecution } from '../commands/scripts/runtime/plan.mjs';
import { communicationCommand, managedCommandInvocation, managedLaunch } from '../commands/scripts/runtime/managed-host.mjs';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';

const resourceRoot = path.dirname(guideRuntimeScripts(import.meta.url));
const selector = 'one/agent-subagent';
const digest = (hex) => `sha256:${hex.repeat(64)}`;

async function fixture(t, platform = 'codex') {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-communication-host-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const producer = { sourceId: 'one', sourceIdentity: digest('a'), pluginName: 'agent-subagent' };
  const installedIdentity = { ...producer, pluginId: selector, platform, pluginVersion: '1.0.0', sourceContentDigest: digest('b') };
  const route = { name: 'message', runner: 'node', entry: 'scripts/message.mjs', args: [], env: {}, envFrom: {}, cwd: 'caller' };
  const target = { selector, owner: { kind: 'plugin', producer }, availability: 'ready', requiresPlatformContext: true, runtimeConfigPlatforms: [platform], resourceRoot,
    pluginVersion: installedIdentity.pluginVersion, sourceContentDigest: installedIdentity.sourceContentDigest,
    routes: { subcommands: [route] }, errors: [], recoveryActions: [] };
  const stateFile = path.join(directory, 'commands.json'), capture = path.join(directory, 'calls.jsonl');
  const cliEntry = path.join(directory, 'aw.mjs');
  // Replace only the public AW boundary. Observe exact argv and protected home.
  await fs.writeFile(cliEntry, `import fs from 'node:fs/promises';
const args=process.argv.slice(2), state=JSON.parse(await fs.readFile(${JSON.stringify(stateFile)},'utf8'));
await fs.appendFile(${JSON.stringify(capture)},JSON.stringify({args,home:process.env.AW_HOME})+'\\n');
if(args[0]!=='command'||args[1]!=='show'||args[3]!=='--json'||args.length!==4)process.exit(2);
const commands=state.commands.filter(c=>c.selector===args[2]);
const partial=commands.some(c=>c.availability==='unavailable');
process.stdout.write(JSON.stringify({schemaVersion:state.schemaVersion,command:'command.show',status:partial?'partial':'success',data:{commands,packages:[],changes:[]},diagnostics:[],nextActions:[]}));
process.exitCode=partial?4:0;`);
  const host = { schemaVersion: 1, nodeExecutable: process.execPath, cliEntry, awHome: directory };
  const environment = { AW_HOME: directory, AW_COMMAND_HOST: JSON.stringify(host), SOURCE_HOME: '/foreign' };
  const snapshot = { installedIdentity, platform, resourceRoot, values: { subagentCommands: [{ key: 'agy', adapter: 'antigravity',
    env: { AW_HOME: '/foreign', AW_COMMAND_HOST: '{}' }, envFrom: { ORDINARY: 'SOURCE_HOME' } }] } };
  const selected = () => selectExecution(snapshot, { executor: 'agy' });
  const save = (commands = [target], schemaVersion = 2) => fs.writeFile(stateFile, JSON.stringify({ commands, schemaVersion }));
  await save();
  return { directory, target, route, host, environment, snapshot, selected, save,
    calls: async () => (await fs.readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse),
    prepare: () => prepareRun(selected(), { prompt: 'task', workspace: directory }, { environment }) };
}

// Test Value Gate: public command show evidence and exact AW argv protect the
// communication route before the adapter receives any backend input.
test('communication selects the same installed producer for every native platform', async (t) => {
  for (const platform of ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'copilot', 'grok']) {
    const f = await fixture(t, platform);
    const prepared = await f.prepare();
    assert.equal(prepared.communicationLaunch.selector, selector + '/' + platform);
    assert.deepEqual(prepared.commandHost, f.host);
    assert.equal(prepared.environment.AW_HOME, f.directory);
    assert.equal(prepared.environment.ORDINARY, '/foreign');
    const invocation = { command: process.execPath, args: [f.host.cliEntry, 'command', 'run', selector + '/' + platform, '--', 'message'] };
    assert.deepEqual(await communicationCommand(prepared.environment), invocation);
    for (const args of [invocation.args.slice(0, -1), [...invocation.args.slice(0, -1), 'start'],
      [f.host.cliEntry, 'command', 'run', 'cmdp_0123456789abcdef', '--', 'message'],
      ['/wrong/cli.mjs', ...invocation.args.slice(1)]]) {
      const invalid = JSON.stringify({ ...invocation, args });
      await assert.rejects(communicationCommand({ ...prepared.environment, AW_SUBAGENT_COMMUNICATION_COMMAND: invalid }),
        { code: 'managedCommandUnavailable' });
    }
    assert.deepEqual(await f.calls(), [{ args: ['command', 'show', selector, '--json'], home: f.directory }]);
    assert.equal(JSON.stringify(prepared.request).includes(f.host.cliEntry), false);
    assert.equal(Object.hasOwn(prepared.request, 'communicationLaunch'), false);
  }
});

test('communication rejects an otherwise valid v1 AW result', async (t) => {
  const f = await fixture(t);
  await f.save([f.target], 1);
  await assert.rejects(f.prepare(), { code: 'managedCommandUnavailable' });
});

// Test Value Gate: a verified platform-bound command needs an actionable
// selector diagnostic without suggesting that unrelated failures share its fix.
test('managed execution suggests a platform suffix only when the verified package requires it', async (t) => {
  const f = await fixture(t, 'pi');
  const launch = (commandId) => managedLaunch(f.host, commandId, f.environment, f.directory, 'message');
  const suffix = /\/<platform>/;
  await assert.rejects(launch(selector), { code: 'executorInvalid', message: suffix });
  const corrected = await launch(`${selector}/pi`);
  assert.deepEqual(managedCommandInvocation(f.host, corrected).args,
    [f.host.cliEntry, 'command', 'run', `${selector}/pi`, '--no-fallback', '--', 'message']);
  await assert.rejects(launch(`${selector}/grok`), (error) => error.code === 'executorInvalid' && !suffix.test(error.message));
  await f.save([{ ...f.target, requiresPlatformContext: null }]);
  await assert.rejects(launch(selector), { code: 'managedCommandUnavailable' });
  await f.save([{ ...f.target, requiresPlatformContext: false, routes: { subcommands: [] } }]);
  await assert.rejects(launch(selector), (error) => error.code === 'executorInvalid' && !suffix.test(error.message));
  assert.ok((await f.calls()).every(({ args }) => args[2] === selector));
});

test('communication requires the verified owner, code, revision and exact named message route', async (t) => {
  const f = await fixture(t);
  const { target, route } = f;
  const owner = (producer) => ({ kind: 'plugin', producer: { ...target.owner.producer, ...producer } });
  for (const [name, commands] of [
    ['missing', []],
    ['ambiguous', [target, target]],
    ['unavailable', [{ ...target, availability: 'unavailable' }]],
    ['wrong source', [{ ...target, owner: owner({ sourceId: 'two' }) }]],
    ['rebound source', [{ ...target, owner: owner({ sourceIdentity: digest('c') }) }]],
    ['no platform context', [{ ...target, requiresPlatformContext: false }]],
    ['unpublished platform', [{ ...target, runtimeConfigPlatforms: [] }]],
    ['wrong version', [{ ...target, pluginVersion: '2.0.0' }]],
    ['wrong source content', [{ ...target, sourceContentDigest: digest('c') }]],
    ['wrong revision', [{ ...target, resourceRoot: f.directory }]],
    ['missing route', [{ ...target, routes: { subcommands: [] } }]],
    ['duplicate route', [{ ...target, routes: { subcommands: [route, route] } }]],
    ['different script', [{ ...target, routes: { subcommands: [{ ...route, entry: 'scripts/subagent.mjs' }] } }]],
    ['different fixed argv', [{ ...target, routes: { subcommands: [{ ...route, args: ['start'] }] } }]],
  ]) {
    await f.save(commands);
    await assert.rejects(f.prepare(), { code: 'managedCommandUnavailable' }, name);
  }
  await assert.rejects(prepareRun(f.selected(), { prompt: 'task', workspace: f.directory }, { environment: {} }), { code: 'managedCommandHostMissing' });
  await assert.rejects(prepareRun(f.selected(), { prompt: 'task', workspace: f.directory }, { environment: { ...f.environment, AW_HOME: '/other-home' } }), { code: 'managedCommandHostInvalid' });
});

test('communication resume follows a snapshot-only revision switch and rejects changed execution evidence', async (t) => {
  const f = await fixture(t);
  const revision = async (name) => {
    const root = path.join(f.directory, name);
    await fs.mkdir(path.join(root, 'scripts', 'adapters'), { recursive: true });
    for (const file of ['worker.mjs', 'adapters/antigravity-v6.mjs']) {
      await fs.copyFile(path.join(resourceRoot, 'scripts', file), path.join(root, 'scripts', file));
    }
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.copyFile(path.join(resourceRoot, 'assets/task-instructions.md'), path.join(root, 'assets/task-instructions.md'));
    return root;
  };
  f.snapshot.resourceRoot = await revision('previous');
  await f.save([{ ...f.target, resourceRoot: f.snapshot.resourceRoot }]);
  const prepared = await f.prepare();
  const configuration = executionConfiguration(prepared, {});
  const nextRoot = await revision('current');
  await f.save([{ ...f.target, resourceRoot: nextRoot }]);
  await fs.rm(f.snapshot.resourceRoot, { recursive: true });
  const runtimeSnapshot = { ...f.snapshot, resourceRoot: nextRoot };
  const options = { runtimeSnapshot, environment: f.environment };
  const resumed = await prepareResume(configuration, 'next task', 'same-session', options);
  assert.equal(resumed.request.sessionId, 'same-session');
  assert.equal(resumed.request.prompt, 'next task');
  assert.equal(resumed.executable.entrypoint, path.join(nextRoot, 'scripts/adapters/antigravity-v6.mjs'));
  assert.deepEqual(resumed.communicationLaunch, prepared.communicationLaunch);
  assert.deepEqual(await communicationCommand(resumed.environment), await communicationCommand(prepared.environment));
  for (const replacement of [{ sourceIdentity: digest('c') }, { pluginVersion: '2.0.0' }, { sourceContentDigest: digest('d') }]) {
    await assert.rejects(prepareResume(configuration, 'next', 'same-session', { ...options,
      runtimeSnapshot: { ...runtimeSnapshot, installedIdentity: { ...runtimeSnapshot.installedIdentity, ...replacement } } }),
    { code: 'resumeExecutionChanged' });
  }
  await f.save([{ ...f.target, resourceRoot: nextRoot, routes: { subcommands: [] } }]);
  await assert.rejects(prepareResume(configuration, 'next', 'same-session', options), { code: 'resumeExecutionChanged' });
  await fs.unlink(f.host.cliEntry);
  await assert.rejects(prepareResume(configuration, 'next', 'same-session', options), { code: 'managedCommandHostInvalid' });
});

test('communication=false does not require a host or inspect managed commands', async (t) => {
  const f = await fixture(t);
  f.snapshot.values.subagentCommands[0].communication = false;
  const prepared = await prepareRun(f.selected(), { prompt: 'task', workspace: f.directory }, { environment: { SOURCE_HOME: '' } });
  assert.equal(prepared.communicationLaunch, undefined);
  assert.equal(prepared.commandHost, undefined);
  assert.equal(prepared.environment.AW_SUBAGENT_COMMUNICATION_COMMAND, undefined);
  await assert.rejects(f.calls(), { code: 'ENOENT' });
});

test('communication rejects unrelated plugin identities and unsupported Guide platforms before AW inspection', async (t) => {
  const f = await fixture(t);
  for (const replacement of [
    { pluginName: 'other-plugin', pluginId: 'one/other-plugin' },
    { pluginId: 'two/agent-subagent' },
    { platform: 'generic' },
  ]) {
    const changed = { ...f.snapshot, installedIdentity: { ...f.snapshot.installedIdentity, ...replacement } };
    const selected = selectExecution(changed, { executor: 'agy' });
    await assert.rejects(prepareRun(selected, { prompt: 'task', workspace: f.directory },
      { environment: f.environment }), { code: 'managedCommandUnavailable' });
  }
  await assert.rejects(f.calls(), { code: 'ENOENT' });
});
