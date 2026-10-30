import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRun, observeRun, openRun, storeContext, workerAlive } from '../skills/codex-subagent-guide/scripts/runtime/store.mjs';
import { protectPrivatePath, verifyPrivatePath } from '../skills/codex-subagent-guide/scripts/runtime/platform.mjs';
import { fixture, sleep, eventually, windows, testTimeoutMs, blocks, field, bounded, successful } from './fixtures/subagent-integration.mjs';

// Test Value Gate: an unrecoverable worker file error must reach the public
// result with safe operation evidence, retain unsent input, and stop its backend.
test('worker file failure retains safe diagnostics and unsent input in the fixed result', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const preload = path.join(f.directory, 'file-failure.mjs');
  await fs.writeFile(preload, `
import fs from 'node:fs/promises';
import path from 'node:path';
if (path.basename(process.argv[1] ?? '') === 'worker.mjs') {
  const rename = fs.rename;
  fs.rename = async (source, destination) => {
    if (path.basename(path.dirname(destination)) === 'outbox') {
      throw Object.assign(new Error('PRIVATE_FILE_FAILURE'), { code: 'EPERM', syscall: 'rename', path: source, dest: destination });
    }
    return rename(source, destination);
  };
}
`);
  const started = await f.start({ echo: true }, { env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
  await f.initialized(started);
  const observed = await started.observed();
  const sent = await f.command(['send', '--run', started.run, '--text', 'Retain unsent input.']);
  successful(sent, 'send');
  await f.waitTerminal(started.run);
  for (let index = 0; index < 2; index++) {
    const result = await f.command(['result', '--run', started.run]);
    successful(result, 'result'); bounded(result);
    assert.equal(field(result.stdout, 'state'), 'unknown');
    assert.equal(field(result.stdout, 'code'), 'EPERM');
    assert.equal(field(result.stdout, 'delivery'), 'notSubmitted');
    assert.deepEqual(blocks(result.stdout, 'INPUT'), ['Retain unsent input.']);
    assert.deepEqual(blocks(result.stdout, 'MESSAGE'), []);
    assert.deepEqual(blocks(result.stdout, 'DIAGNOSTIC').map((text) => JSON.parse(text)), [{
      operation: 'workerFile', syscall: 'rename', source: 'outbox/record.tmp', destination: 'outbox/record',
    }]);
    assert.equal(result.stdout.includes(f.directory), false);
    assert.equal(result.stdout.includes('PRIVATE_FILE_FAILURE'), false);
  }
  assert.throws(() => process.kill(observed.backendPid, 0), { code: 'ESRCH' });
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
});

// Test Value Gate: atomic Windows root publication must not replace a competing
// private directory, alter an unsafe directory, or delete a foreign file. Run
// the real native move at the collision boundary; POSIX rename differs here.
test('Windows root publication preserves a competing existing directory or file', { skip: !windows, timeout: 120000 }, async (t) => {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-root-publication-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  for (const kind of ['privateDirectory', 'inheritedDirectory', 'file']) {
    const isolated = path.join(temporary, kind);
    await fs.mkdir(isolated);
    const context = await storeContext({ homeRoot: isolated });
    const mkdtemp = fs.mkdtemp; const rmdir = fs.rmdir;
    let staging, inserted, sourceRetained = false;
    fs.mkdtemp = async (prefix, ...options) => {
      const created = await mkdtemp(prefix, ...options);
      if (prefix !== `${context.root}-`) return created;
      assert.equal(inserted, undefined);
      staging = created;
      if (kind === 'file') await fs.writeFile(context.root, 'Foreign fixture content.');
      else {
        await fs.mkdir(context.root);
        if (kind === 'privateDirectory') await protectPrivatePath(context.root, 'directory');
      }
      inserted = await fs.lstat(context.root, { bigint: true });
      return created;
    };
    fs.rmdir = async (directory, ...options) => {
      if (directory === staging) {
        const unpublished = await fs.lstat(directory).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        sourceRetained = unpublished?.isDirectory() === true;
      }
      return rmdir(directory, ...options);
    };
    try {
      if (kind === 'privateDirectory') {
        const run = await createRun(context, 'competing-root', temporary);
        assert.equal(run.meta.name, 'competing-root');
      } else await assert.rejects(createRun(context, 'foreign-root', temporary));
    } finally { fs.mkdtemp = mkdtemp; fs.rmdir = rmdir; }
    assert.ok(inserted, 'The publication collision was not exercised.');
    assert.equal(sourceRetained, true, 'Native publication moved the source over an existing resource.');
    const preserved = await fs.lstat(context.root, { bigint: true });
    assert.equal(preserved.dev, inserted.dev); assert.equal(preserved.ino, inserted.ino);
    if (kind === 'file') assert.equal(await fs.readFile(context.root, 'utf8'), 'Foreign fixture content.');
    if (kind === 'inheritedDirectory') {
      assert.deepEqual(await fs.readdir(context.root), []);
      await assert.rejects(verifyPrivatePath(context.root, 'directory', context.owner), 'An unsafe existing directory was taken over.');
    }
    assert.deepEqual(await fs.readdir(isolated), [path.basename(context.root)], 'An unpublished staging directory was left behind.');
    if (process.env.AW_SUBAGENT_COMMUNICATION_DIAGNOSTICS === '1') {
      t.diagnostic(`AW_SUBAGENT_COMMUNICATION_TEST ${JSON.stringify({ phase: 'rootPublicationCollision', kind, publicationRefused: sourceRetained, preserved: true })}`);
    }
  }
});

// Test Value Gate: a final published between the first missing-file read and its
// existence check must be readable even while the cached worker identity is alive.
test('worker final published between missing-file probes remains readable', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const finalText = 'Committed between final-file probes.\r\n保留原文。\n';
  const started = await f.start({ finalText });
  await f.initialized(started);
  const context = await storeContext({ homeRoot: f.homeRoot });
  const run = await openRun(context, started.run);
  assert.equal(await workerAlive(context, run.meta), true);
  const finalFile = path.join(run.directory, 'final.json');
  const ownerFile = path.join(run.directory, 'owner.json');
  const originalLstat = fs.lstat;
  let missingChecks = 0, visibleChecks = 0, committed, observed;
  fs.lstat = async (target, ...options) => {
    try {
      const stat = await originalLstat.call(fs, target, ...options);
      if (target === finalFile && committed) visibleChecks += 1;
      return stat;
    } catch (error) {
      if (target === finalFile && error.code === 'ENOENT' && ++missingChecks === 1) {
        // Preserve this real ENOENT, then let the real worker finish before the
        // parent's existence check. Its process-table observation stays cached.
        await started.finish();
        committed = await eventually(async () => {
          const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
          if (owner.terminalAt === null) return false;
          return { owner, result: JSON.parse(await fs.readFile(finalFile, 'utf8')) };
        }, 'worker final publication between file probes');
        assert.equal(await workerAlive(context, run.meta), true);
      }
      throw error;
    }
  };
  try { observed = await observeRun(context, run); }
  finally { fs.lstat = originalLstat; }
  assert.equal(missingChecks, 1); assert.ok(visibleChecks >= 1);
  assert.equal(committed.result.state, 'completed'); assert.equal(committed.result.text, finalText);
  assert.deepEqual(observed.result, committed.result); assert.equal(observed.snapshot.state, 'completed');
  assert.deepEqual(JSON.parse(await fs.readFile(finalFile, 'utf8')), committed.result);
  assert.equal(JSON.parse(await fs.readFile(ownerFile, 'utf8')).terminalAt, committed.owner.terminalAt);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); assert.deepEqual(blocks(result.stdout, 'FINAL'), [finalText]);
});

// Test Value Gate: a worker may commit and exit after both parent-side missing-file
// observations. Lost-worker recovery must preserve that real final and its TTL.
test('late worker final publication survives a parent lost-worker observation', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const finalText = 'Saved successful answer.\r\n保留最终正文。\n';
  const started = await f.start({ finalText });
  await f.initialized(started);
  const context = await storeContext({ homeRoot: f.homeRoot });
  const run = await openRun(context, started.run);
  const finalFile = path.join(run.directory, 'final.json');
  const ownerFile = path.join(run.directory, 'owner.json');
  const originalLstat = fs.lstat;
  let missingChecks = 0, committed, observed;
  fs.lstat = async (target, ...options) => {
    try { return await originalLstat.call(fs, target, ...options); }
    catch (error) {
      if (target === finalFile && error.code === 'ENOENT' && ++missingChecks === 2) {
        // Keep the already observed ENOENT while the real worker publishes its
        // final and owner metadata, then exits. The parent next observes its exit.
        await started.finish();
        committed = await eventually(async () => {
          try { process.kill(run.meta.worker.pid, 0); return false; }
          catch (exitError) { if (exitError.code !== 'ESRCH') throw exitError; }
          const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
          if (owner.terminalAt === null) return false;
          return { owner, result: JSON.parse(await fs.readFile(finalFile, 'utf8')) };
        }, 'normal worker final publication and exit');
      }
      throw error;
    }
  };
  try { observed = await observeRun(context, run); }
  finally { fs.lstat = originalLstat; }
  assert.ok(committed, 'The missing-file observation must overlap normal worker publication.');
  assert.equal(committed.result.state, 'completed'); assert.equal(committed.result.text, finalText);
  assert.deepEqual(observed.result, committed.result);
  assert.equal(observed.meta.terminalAt, committed.owner.terminalAt);
  assert.deepEqual(JSON.parse(await fs.readFile(finalFile, 'utf8')), committed.result);
  assert.equal(JSON.parse(await fs.readFile(ownerFile, 'utf8')).terminalAt, committed.owner.terminalAt);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); assert.equal(field(result.stdout, 'state'), 'completed');
  assert.deepEqual(blocks(result.stdout, 'FINAL'), [finalText]);
});

// Test Value Gate: worker loss must become one fixed unknown without generating
// new work, and repeat observations must preserve the first expiry origin.
test('lost worker result is fixed once and expires without regenerating work', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  f.snapshot.effectiveValues.subagentRetentionHours = 24; await f.save();
  const started = await f.start({ messages: ['Saved process message.'] });
  await f.initialized(started); await started.published();
  const before = await f.evidence(started.run);
  process.kill(before.meta.worker.pid, 'SIGKILL');
  const result = await eventually(async () => {
    const response = await f.command(['result', '--run', started.run]); return response.code === 0 && response;
  }, 'lost-worker result');
  assert.equal(field(result.stdout, 'state'), 'unknown'); assert.equal(field(result.stdout, 'code'), 'workerLost');
  assert.equal(field(result.stdout, 'generation_started'), 'null');
  assert.deepEqual(blocks(result.stdout, 'MESSAGE'), ['Saved process message.']); assert.deepEqual(blocks(result.stdout, 'FINAL'), ['']);
  const first = await f.evidence(started.run);
  assert.ok(Number.isSafeInteger(first.meta.terminalAt));
  const reread = await f.command(['result', '--run', started.run]);
  successful(reread, 'result'); assert.equal(field(reread.stdout, 'code'), 'workerLost');
  assert.deepEqual(blocks(reread.stdout, 'MESSAGE'), []);
  assert.equal((await f.evidence(started.run)).meta.terminalAt, first.meta.terminalAt);
  assert.equal((await f.command(['wait', '--run', started.run])).stdout, 'settled\n');
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
  const clock = await f.clock(['result'], { now: first.meta.terminalAt });
  await clock.advance(86399999);
  successful(await f.command(['result', '--run', started.run], { env: clock.environment }), 'result');
  assert.equal((await f.evidence(started.run)).meta.terminalAt, first.meta.terminalAt);
  await clock.advance(1);
  const expired = await f.command(['result', '--run', started.run, '--output-file', path.join(f.directory, 'expired-result.txt')], { env: clock.environment });
  assert.equal(expired.code, 1); assert.ok(['runExpired', 'runUnavailable'].includes(field(expired.stderr, 'code')));
  assert.deepEqual(blocks(expired.stdout, 'FINAL'), []);
});

// Test Value Gate: expired ownership and stopped-process evidence must permit
// cleanup even when cached content is damaged; read-only help must not scan.
test('ordinary calls clean expired damaged content while help and invalid flags stay read-only', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  f.snapshot.effectiveValues.subagentRetentionHours = 24; await f.save();
  const started = await f.start({ finishImmediately: true });
  await f.initialized(started); await f.waitTerminal(started.run);
  const run = await f.evidence(started.run);
  await eventually(() => {
    try { process.kill(run.meta.worker.pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }, 'worker exit');
  run.meta.terminalAt = Date.now() - 86400001;
  await fs.writeFile(path.join(run.directory, 'owner.json'), JSON.stringify(run.meta), { mode: 0o600 });
  await fs.writeFile(path.join(run.directory, 'final.json'), '{damaged cached content');
  assert.equal((await f.command(['--help'])).code, 0); await fs.stat(run.directory);
  assert.equal((await f.command(['result', '--run', started.run, '--export', '--output-file', 'unused'])).code, 2); await fs.stat(run.directory);
  const expired = await f.command(['result', '--run', started.run]);
  assert.equal(expired.code, 1); assert.deepEqual(blocks(expired.stdout, 'FINAL'), []);
  await eventually(async () => await fs.stat(run.directory).catch(() => null) === null, 'asynchronous expired execution cleanup');
});

// Test Value Gate: caller wait time must not impose a task deadline. Advance
// separate caller/worker clocks, while keeping real messages and process exits.
test('default run survives simulated time and a caller wait timeout', { timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t);
  const workerClock = await f.clock(['worker']);
  const started = await f.start({ echo: true }, { env: workerClock.environment });
  await f.initialized(started);
  assert.equal((await started.observed()).request.run.deadlineAt, null);
  successful(await f.command(['wait', '--run', started.run, '--timeout-ms', '0']), 'wait');
  const callerClock = await f.clock(['wait'], { stepMs: 100000 });
  const timeout = await f.command(['wait', '--run', started.run], { env: callerClock.environment });
  assert.equal(timeout.code, 0); assert.equal(timeout.stdout, 'timeout\n');
  const [acknowledged] = await callerClock.acknowledgements();
  assert.equal(acknowledged.now - callerClock.origin, 600000);
  await workerClock.advance(1800001);
  const input = 'Input after a simulated former default deadline.';
  successful(await f.command(['send', '--run', started.run, '--text', input]), 'send');
  const changed = await f.command(['wait', '--run', started.run]);
  successful(changed, 'wait'); assert.equal((await f.evidence(started.run)).snapshot.state, 'running');
  assert.deepEqual(blocks(changed.stdout, 'MESSAGE'), [input]);
  assert.deepEqual((await started.inputs(1)).map((message) => message.text), [input]);
  const pending = await f.command(['result', '--run', started.run]);
  assert.equal(pending.code, 1); assert.equal(field(pending.stderr, 'code'), 'resultNotReady');
  assert.equal((await started.observed()).request.run.deadlineAt, null);
  await started.finish(); await f.waitTerminal(started.run);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); assert.equal(field(result.stdout, 'state'), 'completed');
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
  t.diagnostic('Simulated caller_wait_ms=600000 worker_elapsed_ms=1800001; native elapsed qualification is separate.');
});

const longRunSetting = process.env.AW_SUBAGENT_LONG_RUN_MS;
const longRunMilliseconds = longRunSetting === undefined ? null : Number(longRunSetting);
const validLongRun = Number.isSafeInteger(longRunMilliseconds) && longRunMilliseconds > 1800000 && longRunMilliseconds <= 86400000;

// Test Value Gate: the removed 30-minute default deadline requires native elapsed
// time evidence. This opt-in qualification leaves the real worker idle beyond that
// boundary, then verifies the same run can receive input and return its result.
test('long-running default run stays open beyond 30 minutes', {
  skip: longRunSetting === undefined ? 'Set AW_SUBAGENT_LONG_RUN_MS above 1800000 to run native long-duration qualification.' : false,
  timeout: (validLongRun ? longRunMilliseconds : 0) + (windows ? 360000 : 90000),
}, async (t) => {
  assert.ok(validLongRun && /^\d+$/.test(longRunSetting), 'AW_SUBAGENT_LONG_RUN_MS must be an integer from 1800001 through 86400000.');
  const f = await fixture(t);
  const started = await f.start({ echo: true,
    backendLifetimeMs: longRunMilliseconds + (windows ? 300000 : 60000),
    adapterLifetimeMs: longRunMilliseconds + (windows ? 305000 : 65000) });
  await f.initialized(started);
  if (started.code === 0) assert.equal(field(started.stdout, 'communication'), 'true');
  assert.equal((await started.observed()).request.run.deadlineAt, null);
  const began = performance.now();
  while (performance.now() - began < longRunMilliseconds) {
    await sleep(Math.min(60000, longRunMilliseconds - (performance.now() - began)));
    t.diagnostic(`Long-run qualification elapsed_ms=${Math.floor(performance.now() - began)}.`);
  }
  const elapsedMilliseconds = performance.now() - began;
  assert.ok(elapsedMilliseconds >= longRunMilliseconds);
  const input = 'Input after the former default deadline.\r\n保留同一次任务。\n';
  const sent = await f.command(['send', '--run', started.run, '--text', input]);
  successful(sent, 'send'); assert.equal(sent.stdout, `queued ${started.run}\n`);
  const changed = await f.command(['wait', '--run', started.run]);
  successful(changed, 'wait'); bounded(changed);
  assert.equal(field(changed.stdout, 'state'), 'running'); assert.deepEqual(blocks(changed.stdout, 'MESSAGE'), [input]);
  const stillRunning = await f.command(['result', '--run', started.run]);
  assert.equal(stillRunning.code, 1); assert.equal(field(stillRunning.stderr, 'code'), 'resultNotReady');
  assert.deepEqual((await started.inputs(1)).map((message) => message.text), [input]);
  await started.finish(); await f.waitTerminal(started.run);
  const result = await f.command(['result', '--run', started.run]);
  successful(result, 'result'); assert.equal(field(result.stdout, 'state'), 'completed');
  assert.deepEqual(blocks(result.stdout, 'FINAL'), ['Complete final answer.']);
  assert.equal(await fs.readFile(f.generations, 'utf8'), 'generation\n');
  t.diagnostic(`AW_SUBAGENT_LONG_RUN ${JSON.stringify({ requestedMs: longRunMilliseconds, elapsedMs: Math.floor(elapsedMilliseconds), state: 'completed', generations: 1 })}`);
});
