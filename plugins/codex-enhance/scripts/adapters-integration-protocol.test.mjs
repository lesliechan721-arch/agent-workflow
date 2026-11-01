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

test('Codex: initialization failure has no false communication capability', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'initialization failure'); const run = f.start(); run.send(f.request);
  const result = await run.waitFor('result'); assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false);
  assert.equal(run.frames.some((frame) => frame.type === 'ready'), false); assert.equal((await run.exit).code, 0);
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
