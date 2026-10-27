import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, eventually, terminalPattern, testTimeoutMs, blocks, field, bounded, successful } from './fixtures/subagent-integration.mjs';
import { validateFrame } from '../skills/codex-subagent-guide/scripts/runtime/protocol.mjs';

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
  await f.initialized(started); bounded(started);
  const initialized = started.code === 0 ? started : await f.command(['wait', '--run', started.run, '--timeout-ms', '0']);
  if (started.code === 1) successful(initialized, 'wait');
  bounded(initialized);
  assert.ok(blocks(initialized.stdout, 'DIAGNOSTIC').join('\n').includes(diagnostic.code));
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
  for (const response of [started, initialized, result, exported, reread]) {
    assert.equal((response.stdout + response.stderr).includes('base'), false);
  }
});

// Test Value Gate: a legal custom result can exceed the snapshot budget without
// ready. Public reads must stay bounded and export must retain every diagnostic.
test('initialization failure with large diagnostics remains readable and exportable', { timeout: testTimeoutMs }, async (t) => {
  const diagnostics = Array.from({ length: 20 }, (_, index) => ({ code: 'profileFieldIgnored', field: `features.item_${index}`, message: 'x'.repeat(1000) }));
  validateFrame({ protocolVersion: 5, type: 'result', state: 'failed', generationStarted: false, backendExitCode: null,
    text: '', code: 'fixtureInitializationFailed', diagnostics }, 'adapter');
  const f = await fixture(t);
  const clock = await f.clock(['start'], { stepMs: 1000 });
  const started = await f.start({ initializationFailure: true, readyGate: true, diagnostics }, { env: clock.environment });
  bounded(started); assert.equal(started.code, 1);
  assert.match(started.stdout, /^start: notReady\n/);
  assert.equal(field(started.stdout, 'state'), 'starting');
  assert.equal(field(started.stdout, 'environment'), 'pending');
  assert.equal(field(started.stdout, 'communication'), 'pending');
  assert.equal(field(started.stdout, 'code'), 'startupNotReady');
  await started.releaseReady();
  const limited = await eventually(async () => {
    const response = await f.command(['result', '--run', started.run]);
    return field(response.stdout, 'code') !== 'resultNotReady' && response;
  }, 'large initialization result');
  bounded(limited); assert.equal(limited.code, 1);
  assert.equal(field(limited.stdout, 'code'), 'resultTooLarge');
  assert.ok(limited.stdout.includes(`result --run ${started.run} --export`));
  const terminal = (await f.waitTerminal(started.run)).find((response) => terminalPattern.test(response.stdout));
  assert.equal(field(terminal.stdout, 'state'), 'failed');
  assert.equal(field(terminal.stdout, 'environment'), 'pending');
  assert.equal(field(terminal.stdout, 'communication'), 'pending');
  assert.equal(field(terminal.stdout, 'result'), 'deferred');
  assert.match(blocks(terminal.stdout, 'DIAGNOSTIC').join('\n'), /diagnosticsSummarized: 20\b/);
  const exported = await f.command(['result', '--run', started.run, '--export']);
  successful(exported, 'result'); assert.equal(field(exported.stdout, 'state'), 'failed');
  assert.equal(field(exported.stdout, 'code'), 'fixtureInitializationFailed');
  assert.equal(field(exported.stdout, 'environment'), 'pending');
  assert.equal(field(exported.stdout, 'communication'), 'pending');
  assert.equal(field(exported.stdout, 'generation_started'), 'false');
  assert.equal(blocks(exported.stdout, 'DIAGNOSTIC')[0], diagnostics.map((entry) => `${entry.code} (${entry.field}): ${entry.message}`).join('\n'));
  assert.deepEqual(blocks(exported.stdout, 'FINAL'), ['']);
  const reread = await f.command(['result', '--run', started.run, '--export']);
  successful(reread, 'result');
  assert.deepEqual(blocks(reread.stdout, 'DIAGNOSTIC'), blocks(exported.stdout, 'DIAGNOSTIC'));
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'wait: settled\n');
});
