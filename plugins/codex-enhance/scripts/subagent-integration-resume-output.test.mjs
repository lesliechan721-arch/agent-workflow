import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, eventually, testTimeoutMs, blocks, field, bounded, successful } from './fixtures/subagent-integration.mjs';
import { messageBodies } from './fixtures/message-bodies.mjs';
import { executeCommand, parseCommand } from '../skills/codex-subagent-guide/scripts/subagent.mjs';

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
  await first.finish(); await f.stopped(first.run);
  const final = await f.command(['result', '--run', first.run]);
  successful(final, 'result'); bounded(final); assert.ok(Buffer.byteLength(final.stdout) > 31800);
  assert.deepEqual(blocks(final.stdout, 'FINAL'), [finalText]);
});

// Test Value Gate: failed publication must preserve A and discard unpublished B;
// failed startup after publication must keep B and its recovery materials.
test('publication is the boundary between preserving old results and retaining a failed new execution', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const first = await f.start({ resume: true, finishImmediately: true, finalText: 'Old result.' });
  const before = await f.stopped(first.run);
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
  // Fail after the parent saves the native identity. An immediate exit can
  // instead fail identity capture on Windows, which is a different boundary.
  await fs.writeFile(worker, `import fs from 'node:fs/promises';
import path from 'node:path';
const directory = process.argv[process.argv.indexOf('--directory') + 1];
const until = Date.now() + 30000;
for (;;) {
  const owner = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8'));
  if (owner.worker?.pid === process.pid) break;
  if (Date.now() >= until) process.exit(3);
  await new Promise(resolve => setTimeout(resolve, 20));
}
process.exit(0);
`);
  const failed = await f.resume(first, 'Published failed execution.', { resume: true });
  await fs.writeFile(worker, original);
  assert.equal(failed.code, 1); assert.match(failed.stdout, /^(?:start_failed|starting) /);
  const failedResult = await f.command(['result', '--run', first.run]);
  successful(failedResult, 'result');
  const current = await f.evidence(first.run);
  assert.notEqual(current.directory, before.directory); assert.equal(current.result.state, 'unknown');
  assert.equal(await fs.stat(before.directory).catch(() => null), null);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(current.directory, 'session.json'), 'utf8')), { sessionId: 'fixture-session' });
  successful(await f.command(['stop', '--run', first.run]), 'stop');
  const resumed = await f.resume(first, 'Continue after worker failure.', { resume: true });
  await f.initialized(resumed); await resumed.finish(); await f.stopped(first.run);
});

// Test Value Gate: foreground scheduling must not wait for the independent scan,
// propagate its failures, or reread configuration within one command.
test('installed commands use one configuration read and do not wait for or report scanner failures', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const first = await f.start({ finishImmediately: true }); await f.stopped(first.run);
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
  await f.stopped(first.run);
  command.name = 'Changed display name'; await fs.writeFile(launchFile, JSON.stringify(command));
  const resumed = await f.resume(first, 'Keep the original managed execution.', { resume: true });
  await f.initialized(resumed); await resumed.finish();
  const before = await f.stopped(first.run);
  command.launch.args = ['different']; await fs.writeFile(launchFile, JSON.stringify(command));
  const changed = await f.resume(first, 'Do not submit.', { resume: true });
  assert.equal(field(changed.stderr, 'code'), 'resumeExecutionChanged');
  assert.equal((await f.evidence(first.run)).directory, before.directory);
  const launches = (await fs.readFile(invoked, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(launches, Array.from({ length: 2 }, () => ({ argv: ['command', 'run', commandId, '--'], awHome: f.directory })));
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\ngeneration\n');
});

// Test Value Gate: first and repeated session frames after ready must not
// create another public ready notification. One worker exercises both events.
test('first and repeated session confirmations do not repeat the ready notification', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const first = await f.start({ resume: true, sessionAfterReady: true, repeatSessionOnInput: true });
  await f.initialized(first); await first.published();
  successful(await f.command(['wait', '--run', first.run, '--timeout-ms', '0']), 'wait');
  const run = await f.evidence(first.run);
  assert.equal(await fs.stat(path.join(run.directory, 'session.json')).catch(() => null), null);
  for (const [index, text] of ['Bind the first session.', 'Confirm the same session.'].entries()) {
    successful(await f.command(['send', '--run', first.run, '--text', text]), 'send');
    await first.inputs(index + 1);
    await eventually(async () => (await fs.readdir(path.join(run.directory, 'outbox'))).length === 0, 'session input delivery');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(run.directory, 'session.json'), 'utf8')), { sessionId: 'fixture-session' });
    const observed = await f.command(['wait', '--run', first.run, '--timeout-ms', '0']);
    successful(observed, 'wait'); assert.equal(observed.stdout, 'timeout\n');
  }
  await first.finish(); await f.stopped(first.run);
});
