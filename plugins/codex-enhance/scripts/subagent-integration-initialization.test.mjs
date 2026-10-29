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
    f.start({ communication: true, readyGate: true, finishImmediately: true, finalText, diagnostics, descriptor: { status: 'enabled', transport: 'command', passiveDelivery: 'turn-boundary' } }, { env: clock.environment, extra: ['--diagnostics'] }),
  ]);
  for (const [index, started] of [forWait, forResult].entries()) {
    const diagnostic = JSON.stringify({ phase: 'lateReadyStart', case: index === 0 ? 'communicationFalse' : 'communicationTrue',
      code: started.code, elapsedMs: started.elapsedMs, stdout: started.stdout, stderr: started.stderr });
    if (process.env.AW_SUBAGENT_COMMUNICATION_DIAGNOSTICS === '1') t.diagnostic(`AW_SUBAGENT_COMMUNICATION_TEST ${diagnostic}`);
    assert.equal(started.code, 1, diagnostic); assert.match(started.stdout, /^starting aw5-/, diagnostic);
    assert.equal(field(started.stdout, 'communication'), undefined);
    assert.equal(field(started.stderr, 'code'), index === 1 ? 'startupNotReady' : undefined);
  }
  const observations = await clock.acknowledgements();
  assert.equal(observations.length, 2);
  assert.ok(observations.every((value) => value.role === 'start' && value.now - clock.origin === 10000), JSON.stringify(observations));
  f.phase('initializationWindowSimulated', { simulatedElapsedMs: 10000, runs: 2 });
  await Promise.all([forWait.releaseReady(), forResult.releaseReady()]);
  await Promise.all([forWait.finished(), forResult.finished()]);
  const responses = await f.waitTerminal(forWait.run);
  assert.ok(responses.some((response) => field(response.stdout, 'communication') === 'false'));
  assert.ok(responses.every((response) => field(response.stdout, 'environment') === undefined));
  const result = await f.command(['result', '--run', forWait.run]);
  successful(result, 'result'); assert.equal(field(result.stdout, 'communication'), undefined);
  assert.deepEqual(blocks(result.stdout, 'FINAL'), ['Complete final answer.']);
  const resultWithCapability = await eventually(async () => {
    const response = await f.command(['result', '--run', forResult.run]);
    return field(response.stderr, 'code') !== 'resultNotReady' && response;
  }, 'late ready fixed final');
  successful(resultWithCapability, 'result'); assert.equal(field(resultWithCapability.stdout, 'communication'), 'true');
  for (const key of ['communication_status', 'communication_transport', 'communication_passive_delivery', 'communication_active_receive']) assert.equal(field(resultWithCapability.stdout, key), undefined);
  assert.equal(blocks(resultWithCapability.stdout, 'DIAGNOSTIC').length, 1);
  assert.deepEqual(blocks(resultWithCapability.stdout, 'FINAL'), [finalText]);
  const reread = await f.command(['result', '--run', forResult.run]);
  successful(reread, 'result'); assert.equal(field(reread.stdout, 'communication'), undefined);
  assert.deepEqual(blocks(reread.stdout, 'DIAGNOSTIC'), []);
  const detailed = await f.command(['result', '--run', forResult.run, '--diagnostics']);
  assert.deepEqual(blocks(detailed.stdout, 'DIAGNOSTIC'), blocks(resultWithCapability.stdout, 'DIAGNOSTIC'));
  assert.equal((await f.command(['wait', '--run', forResult.run])).stdout, 'settled\n');
});

// Test Value Gate: the real worker must retain ready diagnostics separately from
// later warnings, so default reads stay quiet and --diagnostics can recover them.
test('routine diagnostics are opt-in and final warnings do not repeat ready warnings', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const routine = { code: 'codexExecutableSelected', message: 'Selected fixture Codex.' };
  const warning = { code: 'profileFieldIgnored', field: 'features.fixture', message: 'Unsupported fixture override.' };
  const late = { code: 'backendActionDenied', message: 'A fixture action was denied.' };
  for (const showDiagnostics of [false, true]) {
    const extra = showDiagnostics ? ['--diagnostics'] : [];
    const started = await f.start({ diagnostics: [routine, warning], resultDiagnostics: [late] }, { extra });
    await f.initialized(started);
    const initialized = started.code === 0 ? started : await f.command(['wait', '--run', started.run, '--timeout-ms', '0', ...extra]);
    successful(initialized, started.code === 0 ? 'start' : 'wait');
    assert.deepEqual(blocks(initialized.stdout, 'DIAGNOSTIC'), (showDiagnostics ? [routine, warning] : [warning]).map((entry) => entry.message));
    await started.finish(); await started.finished();
    const terminal = await f.command(['wait', '--run', started.run, ...extra]);
    successful(terminal, 'wait');
    assert.deepEqual(blocks(terminal.stdout, 'DIAGNOSTIC'), (showDiagnostics ? [routine, warning, late] : [late]).map((entry) => entry.message));
    const detailed = await f.command(['result', '--run', started.run, '--diagnostics']);
    successful(detailed, 'result');
    assert.deepEqual(blocks(detailed.stdout, 'DIAGNOSTIC'), [routine, warning, late].map((entry) => entry.message));
  }
});

// Test Value Gate: failed initialization must preserve unknown capability and a
// readable failure, rather than treating missing ready as communication=false.
test('initialization failure has pending capability and a readable failed final', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const started = await f.start({ initializationFailure: true, diagnostics: [{ code: 'profileFieldIgnored', field: 'features.unknown', message: 'Unsupported override; base settings remain active.' }] });
  assert.equal(started.code, 1); assert.equal(field(started.stdout, 'communication'), undefined);
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

// Test Value Gate: failed initialization retains environment evidence internally,
// exposes the necessary failure code, and delivers communication only once.
for (const environment of [{ status: 'available' }, { status: 'unavailable', code: 'executableNotFound' }]) test(`initialization failure preserves ${environment.status} evidence without exposing environment fields`, { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const started = await f.start({ initializationFailure: true, initialization: { environment, capabilities: {} } });
  assert.equal(started.code, 1);
  assert.equal(field(started.stdout, 'environment'), undefined);
  const responses = await f.waitTerminal(started.run);
  const terminal = responses.find((response) => terminalPattern.test(response.stdout));
  assert.equal(field(terminal.stdout, 'state'), 'failed');
  assert.equal(field(terminal.stdout, 'code'), 'fixtureInitializationFailed');
  assert.equal(field(terminal.stdout, 'generation_started'), 'false');
  assert.equal(field(terminal.stdout, 'communication'), 'pending');
  if (environment.code) assert.ok(blocks(terminal.stdout, 'DIAGNOSTIC').length >= 1);
  assert.deepEqual((await f.evidence(started.run)).result.initialization, { environment, capabilities: {} });
  for (const result of [await f.command(['result', '--run', started.run]), { stdout: (await f.exportResult(started.run)).report, code: 0 }]) {
    successful(result, 'result');
    assert.equal(field(result.stdout, 'state'), 'failed');
    assert.equal(field(result.stdout, 'code'), 'fixtureInitializationFailed');
    assert.equal(field(result.stdout, 'environment'), undefined);
    assert.equal(field(result.stdout, 'environment_code'), undefined);
    assert.equal(field(result.stdout, 'communication'), undefined);
  }
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'settled\n');
});

// Test Value Gate: a custom entry can fail before the adapter process exists.
// The same worker result path must retain the safe failure without model input.
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
  assert.equal(field(started.stdout, 'environment'), undefined);
  assert.equal(field(started.stdout, 'communication'), undefined);
  const result = await eventually(async () => {
    const response = await f.command(['result', '--run', started.run]);
    return field(response.stderr, 'code') !== 'resultNotReady' && response;
  }, 'custom initialization failure');
  successful(result, 'result');
  assert.equal(field(result.stdout, 'state'), 'failed');
  assert.equal(field(result.stdout, 'generation_started'), 'false');
  assert.equal(field(result.stdout, 'environment'), undefined);
  assert.equal(field(result.stdout, 'environment_code'), undefined);
  assert.equal(field(result.stdout, 'code'), code);
  assert.deepEqual((await f.evidence(started.run)).result.initialization.environment, { status: 'unavailable', code });
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'settled\n');
  assert.equal(await fs.stat(f.generations).catch(() => null), null);
});
