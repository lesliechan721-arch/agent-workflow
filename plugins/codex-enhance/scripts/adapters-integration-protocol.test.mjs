import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture, supported, testTimeoutMs } from './fixtures/adapter-v5.mjs';

for (const backend of ['codex', 'claude']) for (const scenario of ['no terminal', 'nonzero', 'diagnostic overflow']) test(`${backend}: ${scenario} cannot become completed`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, backend, scenario); const run = f.start(); run.send(f.request);
  const result = await run.waitFor('result'); assert.equal(result.state, 'unknown');
  if (scenario === 'nonzero') assert.equal(result.backendExitCode, 7);
  if (scenario === 'diagnostic overflow') assert.equal(result.code, 'adapterDiagnosticTooLarge');
  assert.equal((await run.exit).code, 0);
});

// Test Value Gate: an actual backend rejection must stop before model input,
// without leaking its message or retrying a reduced configuration.
for (const scenario of ['initialize rejection', 'initialization failure']) test(`Codex: ${scenario} has no model input or retry`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', scenario); const run = f.start(); run.send(f.request);
  const result = await run.waitFor('result'); assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false);
  assert.equal(run.frames.some((frame) => frame.type === 'ready'), false); assert.equal((await run.exit).code, 0);
  const captured = await f.captured();
  assert.equal(captured.filter((value) => value.input?.method === 'turn/start').length, 0);
  assert.equal(captured.filter((value) => value.input?.method === 'initialize').length, 1);
  assert.equal(captured.filter((value) => value.input?.method === 'thread/start').length, scenario === 'initialize rejection' ? 0 : 1);
  assert.equal(JSON.stringify(run.frames).includes('SYNTHETIC_CONFIG_SECRET'), false);
});

test('Codex: native configuration warning is safe and does not enable strict validation', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'configuration warning');
  f.request.args = ['-c', 'future_native_setting={nested="retained"}'];
  const run = f.start(); run.send(f.request);
  const ready = await run.waitFor('ready');
  assert(ready.diagnostics.some((entry) => entry.code === 'backendConfigWarning'));
  const result = await run.waitFor('result');
  assert.equal(result.state, 'completed');
  assert(result.diagnostics.some((entry) => entry.code === 'backendConfigWarning'));
  assert.equal((await run.exit).code, 0);
  const captured = await f.captured();
  assert.equal(captured[0].args.includes('--strict-config'), false);
  assert(captured[0].args.some((arg) => arg.startsWith('future_native_setting=')));
  assert.equal(JSON.stringify(run.frames).includes('SYNTHETIC_CONFIG_SECRET'), false);
});

test('Codex: known ineffective config fails before starting the backend', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex');
  f.request.args = ['-c', 'agents.job_max_runtime_seconds=900'];
  const run = f.start(); run.send(f.request);
  const result = await run.waitFor('result');
  assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false);
  assert(result.diagnostics.some((entry) => entry.field === 'agents.job_max_runtime_seconds'));
  assert.equal(run.frames.some((frame) => frame.type === 'ready'), false);
  assert.equal((await run.exit).code, 0);
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
});

// The installed profile bundle has its own RuntimeError class. Diagnostics must
// carry controlled conversion reasons across that module boundary.
for (const [value, reason] of [['1979-05-27', /date and time precision/], ['-0.0', /negative floating-point zero/]]) test(`Codex: raw ${value} reports its safe conversion reason`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex');
  f.request.args = ['-c', `future={secret="SYNTHETIC_CONFIG_SECRET",value=${value}}`];
  const run = f.start(); run.send(f.request);
  const result = await run.waitFor('result');
  assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false);
  const diagnostic = result.diagnostics.find((entry) => entry.code === 'profileConversionUnsupported');
  assert.equal(diagnostic?.field, 'args.config'); assert.match(diagnostic.message, reason);
  assert.equal(JSON.stringify(run.frames).includes('SYNTHETIC_CONFIG_SECRET'), false);
  assert.equal(JSON.stringify(run.frames).includes(value), false);
  assert.equal((await run.exit).code, 0);
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
});

test('Codex: approval requests cannot be silently granted', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'approval'); const run = f.start(); run.send(f.request);
  const result = await run.waitFor('result'); assert.equal(result.state, 'unknown'); assert.equal(result.code, 'backendApprovalRequired'); await run.exit;
  const values = await f.captured(); const response = values.find((value) => value.input?.id === 'approval-request')?.input;
  assert.ok(response?.error); assert.equal(Object.hasOwn(response, 'result'), false);
});


test('A connection without start cannot succeed or launch a backend', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t); const run = f.start(); run.child.stdin.end();
  const result = await run.exit; assert.equal(result.code, 1); assert.deepEqual(result.frames, []); assert.match(result.diagnostic, /protocolInvalid/);
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
});
