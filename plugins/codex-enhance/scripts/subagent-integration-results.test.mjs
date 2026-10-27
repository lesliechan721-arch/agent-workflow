import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, eventually, testTimeoutMs, blocks, field, bounded, successful } from './fixtures/subagent-integration.mjs';

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
