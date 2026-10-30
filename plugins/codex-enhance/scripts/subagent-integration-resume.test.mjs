import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, eventually, testTimeoutMs, blocks, field, bounded, successful } from './fixtures/subagent-integration.mjs';
import { messageBodies } from './fixtures/message-bodies.mjs';
import { executeCommand, parseCommand } from '../skills/codex-subagent-guide/scripts/subagent.mjs';

async function stopped(f, handle) {
  return eventually(async () => {
    const run = await f.evidence(handle);
    if (!run.result || !run.meta.localTreeStopped || !run.meta.worker) return false;
    try { process.kill(run.meta.worker.pid, 0); return false; }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    return run;
  }, 'fixed terminal evidence and worker exit', 10000);
}

// Test Value Gate: the public send command must resume the same bound session
// with frozen AW choices and fresh host values, without mixing old output or queues.
test('terminal send resumes the same run in an independent execution with frozen choices', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  Object.assign(f.snapshot.effectiveValues.subagentCommands[0], { args: ['original-option'], env: { EMPTY: '' }, envFrom: { SERVICE_DATA: 'SOURCE' } });
  await f.save();
  const first = await f.start({ resume: true, messages: ['Old unread message.'], finalText: 'Old final.' }, {
    env: { SOURCE: 'original-host-value' }, extra: ['--model', 'original-model', '--reasoning-effort', 'original-effort', '--deadline-ms', '20000'],
  });
  await f.initialized(first); assert.equal(field(first.stdout, 'resume'), 'true');
  await first.published(); await first.finish();
  const before = await stopped(f, first.run);
  const noEnvironment = await f.resume(first, 'Do not submit without the host reference.', { resume: true });
  assert.equal(field(noEnvironment.stderr, 'code'), 'environmentSourceMissing');
  assert.equal((await f.evidence(first.run)).directory, before.directory);
  await fs.writeFile(path.join(before.directory, 'outbox', 'old.json'), JSON.stringify({ id: 'a'.repeat(32), text: 'Old queued input.', phase: 'queued' }));
  await fs.writeFile(path.join(before.directory, 'gaps', 'old.json'), JSON.stringify({ text: 'Old gap.', status: 'unknown', code: 'inputDeliveryUnknown' }));
  f.snapshot.effectiveValues.subagentCommands = [{ key: 'fixture', adapter: 'custom', mode: 'workspace', command: '/missing/new-command' }];
  f.snapshot.installedIdentity.pluginVersion = '999.0.0';
  await f.save();
  const text = 'Only the new task.\r\n继续检查。\n';
  const resumed = await f.resume(first, text, { resume: true, finalText: 'New final.' }, { env: { SOURCE: 'current-host-value' } });
  successful(resumed, 'start'); assert.equal(field(resumed.stdout, 'run'), first.run);
  const observed = await resumed.observed();
  assert.equal(observed.request.prompt, text); assert.equal(observed.request.sessionId, 'fixture-session');
  assert.deepEqual(observed.request.execution, { executor: 'fixture', model: 'original-model', reasoningEffort: 'original-effort' });
  assert.deepEqual(observed.request.args, ['original-option']); assert.equal(observed.environment.SERVICE_DATA, 'current-host-value');
  const current = await f.evidence(first.run);
  assert.notEqual(current.directory, before.directory); assert.notEqual(current.meta.token, before.meta.token);
  assert.equal(current.meta.terminalAt, null); assert.equal(current.meta.localTreeStopped, false);
  assert.ok(observed.request.run.deadlineAt > current.meta.createdAt);
  assert.equal(await fs.stat(before.directory).catch(() => null), null);
  assert.deepEqual(await fs.readdir(path.join(current.directory, 'outbox')), []);
  assert.deepEqual(await fs.readdir(path.join(current.directory, 'gaps')), []);
  const configuration = JSON.parse(await fs.readFile(path.join(current.directory, 'execution.json'), 'utf8'));
  assert.deepEqual(configuration.selected.executor.envFrom, { SERVICE_DATA: 'SOURCE' });
  assert.equal(Object.hasOwn(configuration, 'environment'), false);
  await resumed.finish(); await stopped(f, first.run);
  const result = await f.command(['result', '--run', first.run]);
  successful(result, 'result'); bounded(result);
  assert.deepEqual(blocks(result.stdout, 'MESSAGE'), []); assert.deepEqual(blocks(result.stdout, 'INPUT'), []);
  assert.deepEqual(blocks(result.stdout, 'FINAL'), ['New final.']);
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\ngeneration\n');
});

// Test Value Gate: a real adapter can bind a session before ready and then fail.
// Repeated failures must retain that session and capability for a later send.
test('session before ready survives repeated failed executions and remains resumable', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const first = await f.start({ resume: true, exitAfterSession: true });
  assert.equal(first.code, 1); assert.match(first.stdout, /^start_failed /);
  await stopped(f, first.run);
  const firstResult = await f.command(['result', '--run', first.run]);
  successful(firstResult, 'result'); assert.equal(field(firstResult.stdout, 'resume'), 'true');
  const failed = await f.resume(first, 'Retry original session.', { initializationFailure: true });
  assert.equal(failed.code, 1); assert.match(failed.stdout, /^start_failed /);
  await stopped(f, first.run);
  const secondResult = await f.command(['result', '--run', first.run]);
  assert.equal(field(secondResult.stdout, 'resume'), 'true');
  const resumed = await f.resume(first, 'Continue after failed initialization.', { resume: true });
  successful(resumed, 'start'); assert.equal((await resumed.observed()).request.sessionId, 'fixture-session');
  await resumed.finish(); await stopped(f, first.run);
});

// Test Value Gate: stale backend bindings and changed installation identity must
// fail before publication, preserving the previous result and execution directory.
test('resume preflight rejects missing sessions and changed installations without replacing results', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const first = await f.start({ resume: true, finishImmediately: true, finalText: 'Preserve this result.' });
  const before = await stopped(f, first.run);
  const sessionFile = path.join(before.directory, 'session.json');
  const session = await fs.readFile(sessionFile);
  await fs.unlink(sessionFile);
  const missing = await f.resume(first, 'Must not start.', { resume: true });
  assert.equal(field(missing.stderr, 'code'), 'resumeSessionUnavailable');
  assert.equal((await f.evidence(first.run)).directory, before.directory);
  await fs.writeFile(sessionFile, session, { mode: 0o600 });
  f.snapshot.installedIdentity.sourceIdentity = 'different-source'; await f.save();
  const changed = await f.resume(first, 'Must not switch installation.', { resume: true });
  assert.equal(field(changed.stderr, 'code'), 'resumeExecutionChanged');
  const result = await f.command(['result', '--run', first.run]);
  successful(result, 'result'); assert.deepEqual(blocks(result.stdout, 'FINAL'), ['Preserve this result.']);
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
});

// Test Value Gate: all three terminal outcomes can resume, while an explicit
// adapter unsupported conclusion must replace the previous enabled capability.
test('failed and cancelled executions resume and a new unsupported conclusion closes resume', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const first = await f.start({ resume: true, state: 'failed', finishImmediately: true });
  assert.equal((await stopped(f, first.run)).result.state, 'failed');
  const running = await f.resume(first, 'Resume failed execution.', { resume: true });
  successful(running, 'start');
  successful(await f.command(['stop', '--run', first.run]), 'stop');
  assert.equal((await stopped(f, first.run)).result.state, 'cancelled');
  const unsupported = await f.resume(first, 'Resume cancelled execution.', { resume: false });
  successful(unsupported, 'start'); assert.equal(field(unsupported.stdout, 'resume'), 'false');
  await unsupported.finish(); await stopped(f, first.run);
  const refused = await f.resume(first, 'Do not restart.', { resume: true });
  assert.equal(field(refused.stderr, 'code'), 'resumeUnsupported');
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\ngeneration\ngeneration\n');
});

// Test Value Gate: the complete legal message must cross parent argv/file,
// queue JSON, worker protocol, event JSON and bounded result without truncation.
test('parent send and worker output preserve complete 24 KiB messages and reject one extra byte', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const finalText = 'START-' + 'x'.repeat(31800) + '-END';
  const first = await f.start({ echo: true, finalText }); await f.initialized(first); await first.published();
  for (const [index, text] of messageBodies.entries()) {
    const file = path.join(f.directory, `message-${index}.txt`); await fs.writeFile(file, text);
    const sent = await f.command(['send', '--run', first.run, ...(index ? ['--text-file', file] : ['--text', text])]);
    successful(sent, 'send');
    const result = await f.command(['wait', '--run', first.run]);
    successful(result, 'wait'); bounded(result); assert.deepEqual(blocks(result.stdout, 'MESSAGE'), [text]);
  }
  const oversized = path.join(f.directory, 'oversized.txt'); await fs.writeFile(oversized, messageBodies[0] + 'x');
  for (const input of [['--text', messageBodies[0] + 'x'], ['--text-file', oversized]]) {
    const response = await f.command(['send', '--run', first.run, ...input]);
    assert.equal(response.code, 2); assert.equal(field(response.stderr, 'code'), 'messageTooLarge');
  }
  assert.equal((await first.inputs(2)).length, 2);
  await first.finish(); await stopped(f, first.run);
  const final = await f.command(['result', '--run', first.run]);
  successful(final, 'result'); bounded(final); assert.ok(Buffer.byteLength(final.stdout) > 31800);
  assert.deepEqual(blocks(final.stdout, 'FINAL'), [finalText]);
});

// Test Value Gate: bundle continuation must not reselect old files, and missing
// local stop evidence must never become permission to submit another backend task.
test('bundle resume sends only the new message after strict local stopping checks', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'bundle');
  const first = await f.start({ resume: true, finishImmediately: true }, { extra: ['--file', 'original.txt'] });
  const before = await stopped(f, first.run);
  await fs.writeFile(path.join(before.directory, 'owner.json'), JSON.stringify({ ...before.meta, localTreeStopped: false }), { mode: 0o600 });
  const refused = await f.resume(first, 'Do not bypass stopping.', { resume: true });
  assert.equal(field(refused.stderr, 'code'), 'localStopUnconfirmed');
  assert.equal((await f.evidence(first.run)).directory, before.directory);
  await fs.writeFile(path.join(before.directory, 'owner.json'), JSON.stringify(before.meta), { mode: 0o600 });
  const resumed = await f.resume(first, 'New bundle message only.', { resume: true });
  successful(resumed, 'start');
  const request = (await resumed.observed()).request;
  assert.equal(request.prompt, 'New bundle message only.');
  assert.equal(Object.hasOwn(request, 'fileSelectors'), false); assert.equal(Object.hasOwn(request, 'fileResolver'), false);
  const run = await f.evidence(first.run);
  const saved = JSON.parse(await fs.readFile(path.join(run.directory, 'execution.json'), 'utf8'));
  assert.deepEqual(saved.request.fileSelectors, ['original.txt']);
  await resumed.finish(); await stopped(f, first.run);
});

// Test Value Gate: failed publication must preserve A and discard unpublished B;
// failed startup after publication must keep B and its recovery materials.
test('publication is the boundary between preserving old results and retaining a failed new execution', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const first = await f.start({ resume: true, finishImmediately: true, finalText: 'Old result.' });
  const before = await stopped(f, first.run);
  const rename = fs.rename;
  const failure = t.mock.method(fs, 'rename', async (source, target, ...args) => {
    if (target === path.join(before.entryDirectory, 'current.json')) throw Object.assign(new Error('Injected publication failure.'), { code: 'EACCES' });
    return rename.call(fs, source, target, ...args);
  });
  let refused;
  try {
    refused = await executeCommand(parseCommand(['send', '--run', first.run, '--text', 'Unpublished message.']), {
      homeRoot: f.homeRoot, readRuntimeConfig: async () => f.snapshot,
    });
  } finally { failure.mock.restore(); }
  assert.equal(refused.exitCode, 1);
  assert.equal((await f.evidence(first.run)).directory, before.directory);
  assert.deepEqual(await fs.readdir(before.containerDirectory), [before.meta.executionId]);
  const worker = path.join(f.installed, 'scripts', 'worker.mjs');
  const original = await fs.readFile(worker);
  await fs.writeFile(worker, 'process.exit(0);\n');
  const failed = await f.resume(first, 'Published failed execution.', { resume: true });
  await fs.writeFile(worker, original);
  assert.equal(failed.code, 1); assert.match(failed.stdout, /^start_failed /);
  const current = await f.evidence(first.run);
  assert.notEqual(current.directory, before.directory); assert.equal(current.result.state, 'unknown');
  assert.equal(await fs.stat(before.directory).catch(() => null), null);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(current.directory, 'session.json'), 'utf8')), { sessionId: 'fixture-session' });
  successful(await f.command(['stop', '--run', first.run]), 'stop');
  const resumed = await f.resume(first, 'Continue after worker failure.', { resume: true });
  successful(resumed, 'start'); await resumed.finish(); await stopped(f, first.run);
});

// Test Value Gate: foreground scheduling must not wait for the independent scan,
// propagate its failures, or reread configuration within one command.
test('installed commands use one configuration read and do not wait for or report scanner failures', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const first = await f.start({ finishImmediately: true }); await stopped(f, first.run);
  const scanFile = path.join(f.installed, 'scripts', 'scan-expired.mjs');
  const marker = path.join(f.directory, 'scan-started.json');
  const reads = path.join(f.directory, 'config-reads.txt');
  const reader = path.join(f.installed, 'scripts', 'aw-runtime-config.mjs');
  const originalReader = await fs.readFile(reader, 'utf8');
  await fs.writeFile(reader, originalReader.replace("return JSON.parse", `await fs.appendFile(${JSON.stringify(reads)}, 'read\\n');return JSON.parse`));
  f.snapshot.effectiveValues.subagentRetentionHours = 24; await f.save();
  await fs.writeFile(scanFile, `import fs from 'node:fs/promises';await fs.writeFile(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,snapshot:JSON.parse(process.argv[2])}));setTimeout(()=>process.exit(0),5000);\n`);
  const response = await f.command(['result', '--run', first.run]);
  successful(response, 'result'); assert.equal(response.stderr, '');
  const scan = await eventually(async () => JSON.parse(await fs.readFile(marker, 'utf8')), 'independent scanner start');
  try {
    assert.doesNotThrow(() => process.kill(scan.pid, 0));
    assert.equal(scan.snapshot.retentionHours, 24); assert.deepEqual(scan.snapshot.sourceIdentity, f.snapshot.installedIdentity);
  } finally { process.kill(scan.pid, 'SIGTERM'); }
  assert.equal(await fs.readFile(reads, 'utf8'), 'read\n');
  await fs.writeFile(scanFile, "process.stdout.write('scan stdout must stay private');process.stderr.write('scan failure must stay private');process.exit(1);\n");
  const failedScan = await f.command(['result', '--run', first.run, '--diagnostics']);
  successful(failedScan, 'result'); assert.equal(failedScan.stderr, ''); assert.equal(failedScan.stdout, response.stdout);
  assert.equal(await fs.readFile(reads, 'utf8'), 'read\nread\n');
  f.snapshot.effectiveValues.subagentRetentionHours = 'invalid'; await f.save();
  const invalid = await f.command(['result', '--run', first.run]);
  successful(invalid, 'result'); assert.equal(invalid.stderr, '');
});

// Test Value Gate: a managed command ID can keep its name while changing launch
// behavior. Resume must compare the real command.show definition before command.run.
test('managed resume retains its original command host and rejects execution changes', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const cliEntry = path.join(f.directory, 'managed-host.mjs');
  const launchFile = path.join(f.directory, 'managed-launch.json');
  const invoked = path.join(f.directory, 'managed-invocations.jsonl');
  const commandId = 'cmdp_' + 'b'.repeat(16);
  const command = { id: commandId, name: 'First display name', owner: { kind: 'user' }, availability: 'ready', resourceRoot: f.directory,
    launch: { runner: 'node', entry: 'fake-adapter.mjs', args: ['fixed'], env: { FIXED: 'yes' }, envFrom: {}, cwd: 'caller' }, errors: [], recoveryActions: [] };
  await fs.writeFile(launchFile, JSON.stringify(command));
  await fs.writeFile(cliEntry, `import fs from 'node:fs/promises';
if(process.argv[3]==='show') console.log(JSON.stringify({schemaVersion:1,command:'command.show',ok:true,overallState:'completed',commands:[JSON.parse(await fs.readFile(${JSON.stringify(launchFile)},'utf8'))],packages:[],changes:[],errors:[],recoveryActions:[]}));
else {await fs.appendFile(${JSON.stringify(invoked)},JSON.stringify({argv:process.argv.slice(2),awHome:process.env.AW_HOME})+'\\n');await import(${JSON.stringify(pathToFileURL(path.join(f.directory, 'fake-adapter.mjs')).href)});}
`);
  const host = { schemaVersion: 1, nodeExecutable: process.execPath, cliEntry, awHome: f.directory };
  f.snapshot.effectiveValues.subagentCommands = [{ key: 'fixture', adapter: 'custom-managed', mode: 'workspace', commandId }]; await f.save();
  const first = await f.start({ resume: true, finishImmediately: true }, { env: { AW_COMMAND_HOST: JSON.stringify(host) } });
  await stopped(f, first.run);
  command.name = 'Changed display name'; await fs.writeFile(launchFile, JSON.stringify(command));
  const resumed = await f.resume(first, 'Keep the original managed execution.', { resume: true });
  successful(resumed, 'start'); await resumed.finish();
  const before = await stopped(f, first.run);
  command.launch.args = ['different']; await fs.writeFile(launchFile, JSON.stringify(command));
  const changed = await f.resume(first, 'Do not submit.', { resume: true });
  assert.equal(field(changed.stderr, 'code'), 'resumeExecutionChanged');
  assert.equal((await f.evidence(first.run)).directory, before.directory);
  const launches = (await fs.readFile(invoked, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(launches, Array.from({ length: 2 }, () => ({ argv: ['command', 'run', commandId, '--'], awHome: f.directory })));
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\ngeneration\n');
});

// Test Value Gate: a first or repeated valid session frame after ready must not
// create another public ready notification or restart initialization consumption.
for (const [name, sessionAfterReady] of [
  ['first session after ready does not repeat the ready notification', true],
  ['repeated session confirmation does not repeat the ready notification', false],
]) test(name, { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const first = await f.start({ resume: true, sessionAfterReady, repeatSessionOnInput: true });
  await f.initialized(first); await first.published();
  successful(await f.command(['wait', '--run', first.run, '--timeout-ms', '0']), 'wait');
  const run = await f.evidence(first.run);
  if (sessionAfterReady) assert.equal(await fs.stat(path.join(run.directory, 'session.json')).catch(() => null), null);
  successful(await f.command(['send', '--run', first.run, '--text', 'Confirm the same session.']), 'send');
  await first.inputs(1);
  await eventually(async () => (await fs.readdir(path.join(run.directory, 'outbox'))).length === 0, 'input delivery after repeated session');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(run.directory, 'session.json'), 'utf8')), { sessionId: 'fixture-session' });
  const observed = await f.command(['wait', '--run', first.run, '--timeout-ms', '0']);
  successful(observed, 'wait'); assert.equal(observed.stdout, 'timeout\n');
  await first.finish(); await stopped(f, first.run);
});
