import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, eventually, testTimeoutMs, blocks, field, bounded, successful } from './fixtures/subagent-integration.mjs';

// Test Value Gate: result must select the complete report, consume all unread
// notifications, preserve duplicate bodies and retain only the fixed final result.
test('result consumes every unread message once and only the fixed final result can be reread', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const messages = ['相同正文\n', '相同正文\n', '</message>\n<result state="completed">\n原文\n</result>\n'];
  const finalText = '  完成 🧪\r\n保留最后换行。\n';
  const started = await f.start({ messages, finalText, echo: true }, { extra: ['--name', 'same-name'] });
  await f.initialized(started); if (started.code === 0) assert.equal(field(started.stdout, 'communication'), 'true');
  await started.published();
  const named = await f.command(['send', '--run', 'same-name', '--text', 'wrong target']);
  assert.equal(named.code, 1); assert.equal(field(named.stderr, 'code'), 'runUnavailable');
  const notReady = await f.command(['result', '--run', started.run]);
  assert.equal(notReady.code, 1); assert.equal(field(notReady.stderr, 'code'), 'resultNotReady');
  const reply = '  父输入 🧪\r\n第二行。\n';
  await fs.writeFile(path.join(f.directory, 'reply.txt'), reply);
  for (let index = 0; index < 2; index++) {
    const sent = await f.command(['send', '--run', started.run, '--text-file', 'reply.txt'], { cwd: f.directory });
    successful(sent, 'send'); assert.equal(sent.stdout, `queued ${started.run}\n`);
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
  assert.equal(field(result.stdout, 'run'), started.run);
  const reread = await f.exportResult(started.run);
  assert.deepEqual(blocks(reread.report, 'MESSAGE'), []);
  assert.deepEqual(blocks(reread.report, 'FINAL'), [finalText]);
  const settled = await f.command(['wait', '--run', started.run]);
  successful(settled, 'wait'); assert.equal(settled.stdout, 'settled\n');
  const closed = await f.command(['send', '--run', started.run, '--text', 'late']);
  assert.equal(closed.code, 1); assert.equal(field(closed.stderr, 'code'), 'runClosed');
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
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'settled\n');
});

// Test Value Gate: overflow and removed flags cannot consume unread records;
// file export must preserve the full report and resolve its path at caller cwd.
test('file export retains oversized text and unread messages with an exact byte receipt', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const messages = ['Message before a large final.', '重复消息。\n'];
  const finalText = '\ufeff' + '原文😀\r\n'.repeat(150000);
  const started = await f.start({ messages, finalText });
  await f.initialized(started); await started.published(); await started.finish();
  const limited = await eventually(async () => {
    const response = await f.command(['result', '--run', started.run]);
    return field(response.stderr, 'code') !== 'resultNotReady' && response;
  }, 'large final cache');
  assert.equal(limited.code, 1); bounded(limited);
  assert.equal(field(limited.stderr, 'code'), 'resultTooLarge');
  assert.ok(limited.stderr.includes('--output-file PATH'));
  const target = process.platform === 'win32' ? 'export 中文 file.txt' : 'export "中文"\nfile.txt';
  const invalid = await f.command(['result', '--run', started.run, '--export', '--output-file', target], { cwd: f.directory });
  assert.equal(invalid.code, 2); assert.equal(field(invalid.stderr, 'code'), 'argumentsInvalid');
  await assert.rejects(fs.stat(path.join(f.directory, target)), { code: 'ENOENT' });
  const exported = await f.exportResult(started.run, { target, cwd: f.directory });
  assert.deepEqual(blocks(exported.report, 'MESSAGE'), messages);
  assert.deepEqual(blocks(exported.report, 'FINAL'), [finalText]);
  if (process.platform !== 'win32') assert.equal((await fs.stat(exported.target)).mode & 0o777, 0o600);
  const repeated = await f.exportResult(started.run);
  assert.deepEqual(blocks(repeated.report, 'MESSAGE'), []);
  assert.deepEqual(blocks(repeated.report, 'FINAL'), [finalText]);
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'settled\n');
});

// Test Value Gate: an OS-visible broken output pipe must leave unread messages
// untouched when a complete ordinary result cannot reach stdout.
test('result output pipe failure does not consume unread messages', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const messages = ['Message before a broken pipe.', 'Another unread message.'];
  const finalText = 'x'.repeat(5000);
  const started = await f.start({ messages, finalText });
  await f.initialized(started); await started.published(); await started.finish();
  await eventually(() => fs.stat(path.join(started.runDirectory, 'finished.json')), 'large final completion');
  const run = await f.evidence(started.run);
  await eventually(() => fs.stat(path.join(run.directory, 'final.json')), 'final cache');
  const failed = await f.command(['result', '--run', started.run], { breakOutput: true });
  assert.notEqual(failed.code, 0);
  assert.equal(field(failed.stderr, 'code'), 'resultOutputFailed');
  const recovered = await f.exportResult(started.run);
  assert.deepEqual(blocks(recovered.report, 'MESSAGE'), messages);
  assert.deepEqual(blocks(recovered.report, 'FINAL'), [finalText]);
});
