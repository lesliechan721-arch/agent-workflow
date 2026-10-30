import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, testTimeoutMs, blocks, field, bounded, successful } from './fixtures/subagent-integration.mjs';

// Test Value Gate: the public send command must resume the same bound session
// with frozen AW choices and fresh host values, without mixing old output or queues.
test('terminal send resumes the same run in an independent execution with frozen choices', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  // Force the legal pending return on every host. Only the caller's clock
  // advances; the real worker, backend and native observers keep real time.
  const clock = await f.clock(['start', 'send'], { stepMs: 1000 });
  Object.assign(f.snapshot.effectiveValues.subagentCommands[0], { args: ['original-option'], env: { EMPTY: '' }, envFrom: { SERVICE_DATA: 'SOURCE' } });
  await f.save();
  const first = await f.start({ resume: true, readyGate: true, messages: ['Old unread message.'], finalText: 'Old final.' }, {
    // The execution deadline must leave room for native Windows setup and
    // assertions. The test itself still has the normal fixture deadline.
    env: { ...clock.environment, SOURCE: 'original-host-value' }, extra: ['--model', 'original-model', '--reasoning-effort', 'original-effort', '--deadline-ms', '120000'],
  });
  assert.equal(first.code, 1); assert.match(first.stdout, /^starting /);
  await f.initialized(first);
  assert.equal((await f.evidence(first.run)).snapshot.initialization.capabilities.resume.status, 'enabled');
  await first.published(); await first.finish();
  const before = await f.stopped(first.run);
  const noEnvironment = await f.resume(first, 'Do not submit without the host reference.', { resume: true });
  assert.equal(field(noEnvironment.stderr, 'code'), 'environmentSourceMissing');
  assert.equal((await f.evidence(first.run)).directory, before.directory);
  await fs.writeFile(path.join(before.directory, 'outbox', 'old.json'), JSON.stringify({ id: 'a'.repeat(32), text: 'Old queued input.', phase: 'queued' }));
  await fs.writeFile(path.join(before.directory, 'gaps', 'old.json'), JSON.stringify({ text: 'Old gap.', status: 'unknown', code: 'inputDeliveryUnknown' }));
  f.snapshot.effectiveValues.subagentCommands = [{ key: 'fixture', adapter: 'custom', mode: 'workspace', command: '/missing/new-command' }];
  f.snapshot.installedIdentity.pluginVersion = '999.0.0';
  await f.save();
  const text = 'Only the new task.\r\n继续检查。\n';
  const resumed = await f.resume(first, text, { resume: true, readyGate: true, finalText: 'New final.' }, { env: { ...clock.environment, SOURCE: 'current-host-value' } });
  await f.initialized(resumed); assert.equal(field(resumed.stdout, 'run'), first.run);
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
  await resumed.finish(); await f.stopped(first.run);
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
  assert.equal(first.code, 1); assert.match(first.stdout, /^(?:start_failed|starting) /);
  await f.stopped(first.run);
  const firstResult = await f.command(['result', '--run', first.run]);
  successful(firstResult, 'result'); assert.equal(field(firstResult.stdout, 'resume'), 'true');
  const failed = await f.resume(first, 'Retry original session.', { initializationFailure: true });
  assert.equal(failed.code, 1); assert.match(failed.stdout, /^(?:start_failed|starting) /);
  await f.stopped(first.run);
  const secondResult = await f.command(['result', '--run', first.run]);
  assert.equal(field(secondResult.stdout, 'resume'), 'true');
  const resumed = await f.resume(first, 'Continue after failed initialization.', { resume: true });
  await f.initialized(resumed); assert.equal((await resumed.observed()).request.sessionId, 'fixture-session');
  await resumed.finish(); await f.stopped(first.run);
});

// Test Value Gate: all three terminal outcomes can resume, while an explicit
// adapter unsupported conclusion must replace the previous enabled capability.
test('failed and cancelled executions resume and a new unsupported conclusion closes resume', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const first = await f.start({ resume: true, state: 'failed', finishImmediately: true });
  assert.equal((await f.stopped(first.run)).result.state, 'failed');
  const running = await f.resume(first, 'Resume failed execution.', { resume: true });
  await f.initialized(running);
  successful(await f.command(['stop', '--run', first.run]), 'stop');
  assert.equal((await f.stopped(first.run)).result.state, 'cancelled');
  const unsupported = await f.resume(first, 'Resume cancelled execution.', { resume: false });
  await f.initialized(unsupported);
  assert.equal((await f.evidence(first.run)).snapshot.initialization.capabilities.resume.status, 'unsupported');
  await unsupported.finish(); await f.stopped(first.run);
  const refused = await f.resume(first, 'Do not restart.', { resume: true });
  assert.equal(field(refused.stderr, 'code'), 'resumeUnsupported');
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\ngeneration\ngeneration\n');
});
