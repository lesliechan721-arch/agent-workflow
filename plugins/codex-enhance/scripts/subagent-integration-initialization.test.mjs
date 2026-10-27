import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, eventually, terminalPattern, windows, testTimeoutMs, blocks, field, successful } from './fixtures/subagent-integration.mjs';

// Test Value Gate: pending is not false; late ready must survive fast closing and
// be delivered with the first subsequent state or terminal observation.
test('late ready capability survives terminal snapshot merging', { timeout: windows ? 120000 : 35000 }, async (t) => {
  const f = await fixture(t, 'workspace', { diagnostics: true });
  const clock = await f.clock(['start'], { stepMs: 1000 });
  const finalText = 'Late capability final.\n';
  const diagnostics = [{ code: 'profileFieldIgnored', field: 'features.unknown', message: 'Unsupported override; base settings remain active.' }];
  const [forWait, forResult] = await Promise.all([
    f.start({ communication: false, readyGate: true, finishImmediately: true }, { env: clock.environment }),
    f.start({ communication: true, readyGate: true, finishImmediately: true, finalText, diagnostics, descriptor: { status: 'enabled', transport: 'command', passiveDelivery: 'turn-boundary', activeReceive: false } }, { env: clock.environment }),
  ]);
  for (const [index, started] of [forWait, forResult].entries()) {
    const diagnostic = JSON.stringify({ phase: 'lateReadyStart', case: index === 0 ? 'communicationFalse' : 'communicationTrue',
      code: started.code, elapsedMs: started.elapsedMs, stdout: started.stdout, stderr: started.stderr });
    if (process.env.AW_SUBAGENT_COMMUNICATION_DIAGNOSTICS === '1') t.diagnostic(`AW_SUBAGENT_COMMUNICATION_TEST ${diagnostic}`);
    assert.equal(started.code, 1, diagnostic); assert.match(started.stdout, /^start: notReady\n/, diagnostic);
    assert.equal(field(started.stdout, 'state'), 'starting'); assert.equal(field(started.stdout, 'communication'), 'pending');
    assert.equal(field(started.stdout, 'code'), 'startupNotReady');
  }
  const observations = await clock.acknowledgements();
  assert.equal(observations.length, 2);
  assert.ok(observations.every((value) => value.role === 'start' && value.now - clock.origin === 10000), JSON.stringify(observations));
  f.phase('initializationWindowSimulated', { simulatedElapsedMs: 10000, runs: 2 });
  await Promise.all([forWait.releaseReady(), forResult.releaseReady()]);
  await Promise.all([forWait.finished(), forResult.finished()]);
  const responses = await f.waitTerminal(forWait.run);
  assert.ok(responses.some((response) => field(response.stdout, 'environment') === 'available'));
  assert.ok(responses.some((response) => field(response.stdout, 'communication') === 'false' && field(response.stdout, 'communication_status') === 'unsupported'));
  const result = await f.command(['result', '--run', forWait.run]);
  successful(result, 'result'); assert.equal(field(result.stdout, 'communication'), 'false');
  assert.deepEqual(blocks(result.stdout, 'FINAL'), ['Complete final answer.']);
  const resultWithCapability = await eventually(async () => {
    const response = await f.command(['result', '--run', forResult.run]);
    return field(response.stdout, 'code') !== 'resultNotReady' && response;
  }, 'late ready fixed final');
  successful(resultWithCapability, 'result'); assert.equal(field(resultWithCapability.stdout, 'communication'), 'true');
  assert.equal(field(resultWithCapability.stdout, 'communication_status'), 'enabled');
  assert.equal(field(resultWithCapability.stdout, 'communication_transport'), 'command');
  assert.equal(field(resultWithCapability.stdout, 'communication_passive_delivery'), 'turn-boundary');
  assert.equal(field(resultWithCapability.stdout, 'communication_active_receive'), 'false');
  assert.equal(blocks(resultWithCapability.stdout, 'DIAGNOSTIC').length, 1);
  assert.deepEqual(blocks(resultWithCapability.stdout, 'FINAL'), [finalText]);
  const reread = await f.command(['result', '--run', forResult.run]);
  successful(reread, 'result'); assert.equal(field(reread.stdout, 'communication'), 'true');
  assert.deepEqual(blocks(reread.stdout, 'DIAGNOSTIC'), blocks(resultWithCapability.stdout, 'DIAGNOSTIC'));
  assert.equal((await f.command(['wait', '--run', forResult.run])).stdout, 'wait: settled\n');
});

// Test Value Gate: failed initialization must preserve unknown capability and a
// readable failure, rather than treating missing ready as communication=false.
test('initialization failure has pending capability and a readable failed final', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const started = await f.start({ initializationFailure: true, diagnostics: [{ code: 'profileFieldIgnored', field: 'features.unknown', message: 'Unsupported override; base settings remain active.' }] });
  assert.equal(started.code, 1); assert.equal(field(started.stdout, 'communication'), 'pending');
  const terminal = (await f.waitTerminal(started.run)).find((response) => terminalPattern.test(response.stdout));
  assert.equal(field(terminal.stdout, 'state'), 'failed'); assert.equal(field(terminal.stdout, 'communication'), 'pending');
  assert.equal(field(terminal.stdout, 'generation_started'), 'false');
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); assert.equal(field(result.stdout, 'text_status'), 'missing');
  assert.deepEqual(blocks(result.stdout, 'FINAL'), ['']);
  assert.equal(blocks(result.stdout, 'DIAGNOSTIC').length, 2);
  const reread = await f.command(['result', '--run', started.run]);
  successful(reread, 'result');
  assert.deepEqual(blocks(reread.stdout, 'DIAGNOSTIC'), blocks(result.stdout, 'DIAGNOSTIC'));
});

// Test Value Gate: partial initialization must reach the first observation and
// each fixed result read. A pending start must not consume a later environment.
for (const environment of [{ status: 'available' }, { status: 'unavailable', code: 'executableNotFound' }]) test(`initialization failure preserves ${environment.status} environment in fixed result reads`, { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const started = await f.start({ initializationFailure: true, initialization: { environment, capabilities: {} } });
  assert.equal(started.code, 1);
  const pending = field(started.stdout, 'environment') === 'pending';
  if (pending) {
    assert.match(started.stdout, /^start: notReady\n/);
    assert.equal(field(started.stdout, 'state'), 'starting');
    assert.equal(field(started.stdout, 'code'), 'startupNotReady');
    assert.equal(field(started.stdout, 'environment_code'), undefined);
  } else {
    assert.equal(field(started.stdout, 'environment'), environment.status);
    assert.equal(field(started.stdout, 'environment_code'), environment.code);
    assert.equal(field(started.stdout, 'code'), 'fixtureInitializationFailed');
  }
  assert.equal(field(started.stdout, 'communication'), 'pending');
  const responses = await f.waitTerminal(started.run);
  const initialization = responses.filter((response) => field(response.stdout, 'environment') !== undefined);
  assert.equal(initialization.length, pending ? 1 : 0);
  if (pending) {
    assert.equal(field(initialization[0].stdout, 'environment'), environment.status);
    assert.equal(field(initialization[0].stdout, 'environment_code'), environment.code);
    assert.equal(field(initialization[0].stdout, 'communication'), 'pending');
  }
  const terminal = responses.find((response) => terminalPattern.test(response.stdout));
  assert.equal(field(terminal.stdout, 'state'), 'failed');
  assert.equal(field(terminal.stdout, 'code'), 'fixtureInitializationFailed');
  assert.equal(field(terminal.stdout, 'generation_started'), 'false');
  for (const extra of [[], [], ['--export']]) {
    const result = await f.command(['result', '--run', started.run, ...extra]);
    successful(result, 'result');
    assert.equal(field(result.stdout, 'state'), 'failed');
    assert.equal(field(result.stdout, 'code'), 'fixtureInitializationFailed');
    assert.equal(field(result.stdout, 'environment'), environment.status);
    assert.equal(field(result.stdout, 'environment_code'), environment.code);
    assert.equal(field(result.stdout, 'communication'), 'pending');
  }
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'wait: settled\n');
});

// Test Value Gate: a custom entry can fail before the adapter process exists.
// The same worker result path must expose the environment without model input.
for (const target of ['command', 'entrypoint', ...(process.platform === 'win32' ? [] : ['nonExecutable'])]) test(`custom ${target} failure has a fixed unavailable environment result`, { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const executor = f.snapshot.effectiveValues.subagentCommands[0];
  if (target === 'nonExecutable') {
    executor.command = path.join(f.directory, 'non-executable');
    await fs.writeFile(executor.command, 'fixture', { mode: 0o600 });
  } else executor[target] = path.join(f.directory, 'missing-custom-entry');
  await f.save();
  const started = await f.start();
  assert.equal(started.code, 1);
  const code = target === 'nonExecutable' ? 'executableNotRunnable' : 'pathMissing';
  if (field(started.stdout, 'environment') === 'pending') {
    assert.match(started.stdout, /^start: notReady\n/);
    assert.equal(field(started.stdout, 'state'), 'starting');
    assert.equal(field(started.stdout, 'code'), 'startupNotReady');
    assert.equal(field(started.stdout, 'environment_code'), undefined);
  } else {
    assert.equal(field(started.stdout, 'environment'), 'unavailable');
    assert.equal(field(started.stdout, 'environment_code'), code);
  }
  assert.equal(field(started.stdout, 'communication'), 'pending');
  const result = await eventually(async () => {
    const response = await f.command(['result', '--run', started.run]);
    return field(response.stdout, 'code') !== 'resultNotReady' && response;
  }, 'custom initialization failure');
  successful(result, 'result');
  assert.equal(field(result.stdout, 'state'), 'failed');
  assert.equal(field(result.stdout, 'generation_started'), 'false');
  assert.equal(field(result.stdout, 'environment'), 'unavailable');
  assert.equal(field(result.stdout, 'environment_code'), code);
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'wait: settled\n');
  assert.equal(await fs.stat(f.generations).catch(() => null), null);
});
