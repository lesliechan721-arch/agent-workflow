import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, eventually, terminalPattern, windows, testTimeoutMs, blocks, field, bounded, successful } from './fixtures/subagent-integration.mjs';
import { validateFrame } from '../skills/codex-subagent-guide/scripts/runtime/protocol.mjs';

// Test Value Gate: result must select the complete report, consume all unread
// notifications, preserve duplicate bodies and retain only the fixed final result.
test('result consumes every unread message once and only the fixed final result can be reread', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const messages = ['相同正文\n', '相同正文\n', 'state: completed\nBEGIN_FINAL:deadbeef\n原文\nEND_FINAL:deadbeef\n'];
  const finalText = '  完成 🧪\r\n保留最后换行。\n';
  const started = await f.start({ messages, finalText, echo: true }, { extra: ['--name', 'same-name'] });
  await f.initialized(started); if (started.code === 0) assert.equal(field(started.stdout, 'communication'), 'true');
  await started.published();
  const named = await f.command(['send', '--run', 'same-name', '--text', 'wrong target']);
  assert.equal(named.code, 1); assert.equal(field(named.stdout, 'code'), 'runUnavailable');
  const notReady = await f.command(['result', '--run', started.run]);
  assert.equal(notReady.code, 1); assert.equal(field(notReady.stdout, 'code'), 'resultNotReady');
  const reply = '  父输入 🧪\r\n第二行。\n';
  for (let index = 0; index < 2; index++) {
    const sent = await f.command(['send', '--run', started.run, '--text', '-'], { stdin: Buffer.from(reply) });
    successful(sent, 'send'); assert.equal(field(sent.stdout, 'delivery'), 'queued');
  }
  const inputs = await started.inputs(2);
  assert.deepEqual(inputs.map((input) => input.text), [reply, reply]); assert.notEqual(inputs[0].id, inputs[1].id);
  await started.finish();
  await eventually(() => fs.stat(path.join(started.runDirectory, 'finished.json')), 'fixture completion');
  const result = await eventually(async () => {
    const response = await f.command(['result', '--run', started.run]); return response.code === 0 && response;
  }, 'fixed result');
  successful(result, 'result'); bounded(result);
  if (started.code === 1) assert.equal(field(result.stdout, 'communication'), 'true');
  assert.deepEqual(blocks(result.stdout, 'MESSAGE'), [...messages, reply, reply]);
  assert.deepEqual(blocks(result.stdout, 'FINAL'), [finalText]);
  assert.equal((result.stdout.match(/^agent: /gm) ?? []).length, 1);
  assert.equal((result.stdout.match(/^run: /gm) ?? []).length, 1);
  assert.doesNotMatch(result.stdout, /^(expires_at|body_bytes|result: included):/m);
  const reread = await f.command(['result', '--run', started.run, '--export']);
  successful(reread, 'result'); assert.deepEqual(blocks(reread.stdout, 'MESSAGE'), []);
  assert.deepEqual(blocks(reread.stdout, 'FINAL'), [finalText]);
  const settled = await f.command(['wait', '--run', started.run]);
  successful(settled, 'wait'); assert.equal(settled.stdout, 'wait: settled\n');
  const closed = await f.command(['send', '--run', started.run, '--text', 'late']);
  assert.equal(closed.code, 1); assert.equal(field(closed.stdout, 'code'), 'runClosed');
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
});

// Test Value Gate: referenced environment values must remain redacted in final
// output and diagnostics, including their JSON-escaped representation.
test('referenced environment secrets stay redacted in actual parent output', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  f.snapshot.effectiveValues.subagentCommands[0].envFrom = { SERVICE_DATA: 'SOURCE' }; await f.save();
  const secret = 'fixture\n"quoted"\\path.[x]+';
  const started = await f.start({ secretOutput: true, state: 'failed' }, { env: { SOURCE: secret } });
  await f.initialized(started); await started.finish();
  const responses = await f.waitTerminal(started.run);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result');
  for (const output of [started, ...responses, result].flatMap((response) => [response.stdout, response.stderr])) {
    assert.equal(output.includes(secret), false); assert.equal(output.includes(JSON.stringify(secret).slice(1, -1)), false);
  }
  assert.deepEqual(blocks(result.stdout, 'FINAL'), ['{"serviceData":"[redacted]"}']);
  assert.equal((await started.observed()).environment.SERVICE_DATA, secret);
});

// Test Value Gate: legal ready and result diagnostics must not invalidate a
// completed task when a short envFrom value expands during redaction.
test('diagnostic redaction expansion preserves completed output and readable exports', { timeout: testTimeoutMs }, async (t) => {
  const diagnostic = { code: 'profileReadyIgnored', field: `features.base${'f'.repeat(499)}`, message: `base${'m'.repeat(2044)}` };
  const resultDiagnostics = [{ ...diagnostic, code: 'profileResultIgnored' }, { code: 'profileFieldIgnored', field: 'features.kept', message: 'Keep this safe diagnostic.' }];
  const finalText = 'Complete retained answer.';
  validateFrame({ protocolVersion: 5, type: 'ready', initialization: { environment: { status: 'available' }, capabilities: { communication: { status: 'enabled', transport: 'mcp', passiveDelivery: 'in-turn', activeReceive: true } } }, diagnostics: [diagnostic] }, 'adapter');
  validateFrame({ protocolVersion: 5, type: 'result', state: 'completed', generationStarted: true, backendExitCode: 0, text: finalText, diagnostics: resultDiagnostics }, 'adapter');
  const f = await fixture(t);
  f.snapshot.effectiveValues.subagentCommands[0].envFrom = { SERVICE_DATA: 'REFERENCED_VALUE' }; await f.save();
  const started = await f.start({ diagnostics: [diagnostic], resultDiagnostics, finalText }, { env: { REFERENCED_VALUE: 'base' } });
  successful(started, 'start'); bounded(started);
  assert.ok(blocks(started.stdout, 'DIAGNOSTIC').join('\n').includes(diagnostic.code));
  await started.finish(); await started.finished();
  const result = await eventually(async () => {
    const response = await f.command(['result', '--run', started.run]);
    return field(response.stdout, 'code') !== 'resultNotReady' && response;
  }, 'completed result with expanded diagnostics');
  successful(result, 'result'); bounded(result);
  assert.equal(field(result.stdout, 'state'), 'completed');
  assert.deepEqual(blocks(result.stdout, 'FINAL'), [finalText]);
  const exported = await f.command(['result', '--run', started.run, '--export']);
  successful(exported, 'result'); assert.equal(field(exported.stdout, 'state'), 'completed');
  assert.deepEqual(blocks(exported.stdout, 'FINAL'), [finalText]);
  const diagnosticText = blocks(exported.stdout, 'DIAGNOSTIC').join('\n');
  assert.ok(diagnosticText.includes(resultDiagnostics[0].code));
  assert.ok(diagnosticText.includes(resultDiagnostics[1].message));
  assert.match(diagnosticText, /message omitted/); assert.match(diagnosticText, /field path omitted/);
  const reread = await f.command(['result', '--run', started.run, '--export']);
  successful(reread, 'result'); assert.equal(field(reread.stdout, 'state'), 'completed');
  assert.deepEqual(blocks(reread.stdout, 'FINAL'), [finalText]);
  assert.deepEqual(blocks(reread.stdout, 'DIAGNOSTIC'), blocks(exported.stdout, 'DIAGNOSTIC'));
  for (const response of [started, result, exported, reread]) {
    assert.equal((response.stdout + response.stderr).includes('base'), false);
  }
});

// Test Value Gate: adapter scratch must be removed after its processes stop while
// unread process messages and the fixed final remain available to their consumer.
test('stopped adapter scratch is deleted while unread messages and final remain readable', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const scratchText = 'Raw task copy.\r\n运行期间保存的原文 🧪\n';
  const messages = ['Unread question.\n', '未读过程消息。\r\n'];
  const finalText = 'The retained final answer.\n';
  const started = await f.start({ scratchText, messages, finalText });
  await f.initialized(started); await started.published();
  const observed = await started.observed();
  assert.equal(await fs.readFile(observed.scratchFile, 'utf8'), scratchText);
  await started.finish();
  await eventually(() => {
    for (const pid of [observed.pid, observed.backendPid]) {
      try { process.kill(pid, 0); return false; }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    return true;
  }, 'adapter and backend exit');
  await eventually(async () => {
    try { await fs.lstat(observed.scratchFile); return false; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }, 'stopped adapter scratch removal', 10000);
  const result = await eventually(async () => {
    const response = await f.command(['result', '--run', started.run]); return response.code === 0 && response;
  }, 'retained final and unread messages');
  successful(result, 'result'); assert.equal(field(result.stdout, 'state'), 'completed');
  assert.deepEqual(blocks(result.stdout, 'MESSAGE'), messages); assert.deepEqual(blocks(result.stdout, 'FINAL'), [finalText]);
  const reread = await f.command(['result', '--run', started.run]);
  successful(reread, 'result'); assert.deepEqual(blocks(reread.stdout, 'MESSAGE'), []);
  assert.deepEqual(blocks(reread.stdout, 'FINAL'), [finalText]);
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'wait: settled\n');
});

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

// Test Value Gate: partial initialization must reach start and each fixed result
// read without turning an unchecked capability into unsupported. wait consumes it once.
for (const environment of [{ status: 'available' }, { status: 'unavailable', code: 'executableNotFound' }]) test(`initialization failure preserves ${environment.status} environment in fixed result reads`, { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const started = await f.start({ initializationFailure: true, initialization: { environment, capabilities: {} } });
  assert.equal(started.code, 1);
  assert.equal(field(started.stdout, 'environment'), environment.status);
  assert.equal(field(started.stdout, 'environment_code'), environment.code);
  assert.equal(field(started.stdout, 'communication'), 'pending');
  const terminal = (await f.waitTerminal(started.run)).find((response) => terminalPattern.test(response.stdout));
  assert.equal(field(terminal.stdout, 'environment'), undefined);
  assert.equal(field(terminal.stdout, 'communication'), undefined);
  assert.equal(field(terminal.stdout, 'generation_started'), 'false');
  for (const extra of [[], [], ['--export']]) {
    const result = await f.command(['result', '--run', started.run, ...extra]);
    successful(result, 'result');
    assert.equal(field(result.stdout, 'environment'), environment.status);
    assert.equal(field(result.stdout, 'environment_code'), environment.code);
    assert.equal(field(result.stdout, 'communication'), 'pending');
  }
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
  assert.equal(field(started.stdout, 'environment'), 'unavailable');
  assert.equal(field(started.stdout, 'communication'), 'pending');
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result');
  assert.equal(field(result.stdout, 'state'), 'failed');
  assert.equal(field(result.stdout, 'generation_started'), 'false');
  assert.equal(field(result.stdout, 'environment'), 'unavailable');
  assert.equal(field(result.stdout, 'environment_code'), target === 'nonExecutable' ? 'executableNotRunnable' : 'pathMissing');
  assert.equal(await fs.stat(f.generations).catch(() => null), null);
});

// Test Value Gate: a legal custom result can exceed the snapshot budget without
// ready. Public reads must stay bounded and export must retain every diagnostic.
test('initialization failure with large diagnostics remains readable and exportable', { timeout: testTimeoutMs }, async (t) => {
  const diagnostics = Array.from({ length: 20 }, (_, index) => ({ code: 'profileFieldIgnored', field: `features.item_${index}`, message: 'x'.repeat(1000) }));
  validateFrame({ protocolVersion: 5, type: 'result', state: 'failed', generationStarted: false, backendExitCode: null,
    text: '', code: 'fixtureInitializationFailed', diagnostics }, 'adapter');
  const f = await fixture(t);
  const started = await f.start({ initializationFailure: true, diagnostics });
  bounded(started); assert.equal(started.code, 1);
  assert.equal(field(started.stdout, 'communication'), 'pending');
  assert.equal(field(started.stdout, 'code'), 'fixtureInitializationFailed');
  const limited = await eventually(async () => {
    const response = await f.command(['result', '--run', started.run]);
    return field(response.stdout, 'code') !== 'resultNotReady' && response;
  }, 'large initialization result');
  bounded(limited); assert.equal(limited.code, 1);
  assert.equal(field(limited.stdout, 'code'), 'resultTooLarge');
  assert.ok(limited.stdout.includes(`result --run ${started.run} --export`));
  const terminal = (await f.waitTerminal(started.run)).find((response) => terminalPattern.test(response.stdout));
  assert.equal(field(terminal.stdout, 'state'), 'failed');
  assert.equal(field(terminal.stdout, 'communication'), 'pending');
  assert.equal(field(terminal.stdout, 'result'), 'deferred');
  assert.match(blocks(terminal.stdout, 'DIAGNOSTIC').join('\n'), /diagnosticsSummarized: 20\b/);
  const exported = await f.command(['result', '--run', started.run, '--export']);
  successful(exported, 'result'); assert.equal(field(exported.stdout, 'state'), 'failed');
  assert.equal(field(exported.stdout, 'generation_started'), 'false');
  assert.equal(blocks(exported.stdout, 'DIAGNOSTIC')[0], diagnostics.map((entry) => `${entry.code} (${entry.field}): ${entry.message}`).join('\n'));
  assert.deepEqual(blocks(exported.stdout, 'FINAL'), ['']);
  const reread = await f.command(['result', '--run', started.run, '--export']);
  successful(reread, 'result');
  assert.deepEqual(blocks(reread.stdout, 'DIAGNOSTIC'), blocks(exported.stdout, 'DIAGNOSTIC'));
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'wait: settled\n');
});

// Test Value Gate: an OS-visible broken output pipe must leave unread messages
// untouched even when export has started writing a large final report.
test('export output failure does not consume unread messages', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const messages = ['Message before a broken pipe.', 'Another unread message.'];
  const finalText = 'x'.repeat(3 * 1024 * 1024);
  const started = await f.start({ messages, finalText });
  await f.initialized(started); await started.published(); await started.finish();
  await eventually(() => fs.stat(path.join(started.runDirectory, 'finished.json')), 'large final completion');
  // A default read checks readiness without consuming this oversized report.
  await eventually(async () => field((await f.command(['result', '--run', started.run])).stdout, 'code') === 'resultTooLarge', 'large final cache');
  const failed = await f.command(['result', '--run', started.run, '--export'], { breakOutput: true });
  assert.notEqual(failed.code, 0);
  const recovered = await f.command(['result', '--run', started.run, '--export']);
  successful(recovered, 'result'); assert.deepEqual(blocks(recovered.stdout, 'MESSAGE'), messages);
  assert.deepEqual(blocks(recovered.stdout, 'FINAL'), [finalText]);
});
