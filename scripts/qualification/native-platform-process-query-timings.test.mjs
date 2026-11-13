import assert from 'node:assert/strict';
import test from 'node:test';
import { createProcessQueryTimingDiagnostic } from './native-platform-process-query-timings.mjs';
import { createProcessNameDiagnostic } from './native-platform-process-names.mjs';

const identity = ['-A', '-o', 'pid=,ppid=,pgid=,state=,lstart='];
const marker = ['eww', '-A', '-o', 'pid=,ppid=,pgid=,state=,lstart=,command='];
const settings = Object.freeze({ timeout: 2000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

// Test Value Gate: only the observer's existing query shapes are timed, with
// exact argument/option objects, callback values, receiver, and child handle.
test('records actual query callbacks without retaining their private inputs or output', () => {
  const cases = [
    ['ps', identity, 'identity-ps'],
    ['ps', [...identity.slice(0, 2), `${identity[2]},ucomm=`], 'identity-ps'],
    ['ps', marker, 'marker-ps'],
    ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'private-script', 'private-marker-request'], 'darwin-marker-osascript'],
  ];
  for (const [command, args, kind] of cases) {
    const handle = {}; const receiver = {}; let now = 1000; let calls = 0;
    const error = Object.assign(new Error('private-error-message'), { code: 'ETIMEDOUT' });
    const stdout = '界🙂'; const stderr = Buffer.from('private-stderr'); const extra = {};
    const values = kind === 'marker-ps' ? [error, stdout, stderr, extra] : [null, stdout];
    const diagnostic = createProcessQueryTimingDiagnostic((receivedCommand, receivedArgs, options, callback) => {
      calls++; assert.equal(receivedCommand, command); assert.equal(receivedArgs, args); assert.equal(options, settings);
      now = 1100; assert.equal(callback.apply(receiver, values), 'original-callback-result'); return handle;
    }, () => now);
    assert.equal(diagnostic.execFile(command, args, settings, function (...received) {
      assert.equal(this, receiver); assert.equal(received.length, values.length);
      received.forEach((value, index) => assert.equal(value, values[index]));
      return 'original-callback-result';
    }), handle);
    assert.equal(calls, 1);
    const snapshot = diagnostic.snapshot(); const record = snapshot.records[0];
    assert.equal(record.queryKind, kind); assert.equal(record.sequence, 1);
    assert.equal(record.startedAt, 1000); assert.equal(record.callbackAt, 1100); assert.equal(record.timeoutMs, 2000);
    assert.equal(record.status, error === values[0] ? 'callback-error' : 'callback-success');
    assert.deepEqual(record.stdoutLength, { value: 3, unit: 'string-code-units', capped: false });
    if (values[0]) {
      assert.equal(record.errorCategory, 'timeout');
      assert.deepEqual(record.stderrLength, { value: stderr.length, unit: 'buffer-bytes', capped: false });
    }
    for (const secret of ['private-script', 'private-marker-request', 'private-error-message', 'private-stderr', '界']) {
      assert(!JSON.stringify(snapshot).includes(secret));
    }
  }
});

test('passes unrelated commands and their original callback through without a timing record', () => {
  const calls = []; const handle = {}; const callback = () => {};
  const diagnostic = createProcessQueryTimingDiagnostic((...values) => { calls.push(values); return handle; });
  for (const [command, args] of [['git', ['status']], ['ps', ['-p', '123']], ['/usr/bin/osascript', ['-e', 'unrelated-script']]]) {
    assert.equal(diagnostic.execFile(command, args, settings, callback), handle);
    assert.deepEqual(calls.at(-1), [command, args, settings, callback]);
  }
  assert.equal(calls.length, 3); assert.equal(diagnostic.snapshot(), undefined);
});

// Test Value Gate: timing must observe the real ucomm query below the existing
// name projection, while the observer still receives the original five columns.
test('composes below name projection without adding a query or changing its result', () => {
  const raw = '100 1 100 S Fri Nov 13 09:14:37 2026 node\n';
  const projected = '100 1 100 S Fri Nov 13 09:14:37 2026\n';
  let calls = 0;
  const handle = {};
  const timings = createProcessQueryTimingDiagnostic((command, args, options, callback) => {
    calls++; assert.equal(command, 'ps'); assert.equal(args[2], `${identity[2]},ucomm=`);
    assert.equal(options, settings); callback(null, raw); return handle;
  });
  const names = createProcessNameDiagnostic(timings.execFile);
  assert.equal(names.execFile('ps', identity, settings, (error, stdout) => {
    assert.equal(error, null); assert.equal(stdout, projected);
  }), handle);
  assert.equal(calls, 1);
  assert.equal(timings.snapshot().records[0].stdoutLength.value, raw.length);
});

// Test Value Gate: an observer deadline can settle before execFile's callback.
// Pending is evidence of no callback at capture time, not a fabricated error.
test('keeps pending queries truthful and saved snapshots stable across late callbacks and stop', () => {
  const callbacks = []; let delivered = 0;
  const diagnostic = createProcessQueryTimingDiagnostic((command, args, options, callback) => callbacks.push(callback));
  diagnostic.execFile('ps', marker, settings, () => { delivered++; });
  const pending = diagnostic.snapshot();
  assert.equal(pending.records[0].status, 'pending'); assert.equal(pending.records[0].callbackAt, undefined);
  callbacks[0](null, 'completed');
  assert.equal(diagnostic.snapshot().records[0].status, 'callback-success');
  assert.equal(pending.records[0].status, 'pending');
  diagnostic.execFile('ps', marker, settings, () => { delivered++; });
  diagnostic.stop(); callbacks[1](new Error('late original error'), 'late original output');
  assert.equal(delivered, 2);
  const stopped = diagnostic.snapshot().records[1];
  assert.equal(stopped.status, 'pending'); assert.equal(stopped.callbackAt, undefined);
  assert.equal(stopped.errorCategory, undefined);
});

test('bounds first and final events and reports omitted queries and capped lengths', () => {
  const diagnostic = createProcessQueryTimingDiagnostic((command, args, options, callback) => callback(null, 'result'));
  for (let index = 0; index < 40; index++) diagnostic.execFile('ps', identity, settings, () => {});
  const snapshot = diagnostic.snapshot();
  assert.equal(snapshot.records.length, 24); assert.equal(snapshot.omitted, 16);
  assert.deepEqual(snapshot.records.slice(0, 8).map(record => record.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(snapshot.records[8].sequence, 25); assert.equal(snapshot.records.at(-1).sequence, 40);
  const oversized = Buffer.alloc(16 * 1024 * 1024 + 1);
  const lengths = createProcessQueryTimingDiagnostic((command, args, options, callback) => callback(null, oversized));
  lengths.execFile('ps', identity, settings, () => {});
  assert.deepEqual(lengths.snapshot().records[0].stdoutLength, { value: 16 * 1024 * 1024, unit: 'buffer-bytes', capped: true });
});

// Test Value Gate: record/clock failures cannot alter query throws or callbacks;
// a callback's own throw must not be relabeled as a synchronous execFile failure.
test('preserves original exceptions even when diagnostic capture fails', () => {
  const original = Object.assign(new Error('original query failure'), { code: 1 });
  const synchronous = createProcessQueryTimingDiagnostic(() => { throw original; });
  assert.throws(() => synchronous.execFile('ps', marker, settings, () => assert.fail()), error => error === original);
  const record = synchronous.snapshot().records[0];
  assert.equal(record.status, 'synchronous-error'); assert.equal(record.callbackAt, undefined);
  assert.equal(record.errorCategory, 'nonzero-exit');

  const callbackFailure = new Error('original callback failure');
  const throwingCallback = createProcessQueryTimingDiagnostic((command, args, options, callback) => callback(null, 'original'));
  assert.throws(() => throwingCallback.execFile('ps', marker, settings, () => { throw callbackFailure; }), error => error === callbackFailure);
  assert.equal(throwingCallback.snapshot().records[0].status, 'callback-success');

  const handle = {}; let callbacks = 0;
  const badClock = createProcessQueryTimingDiagnostic((command, args, options, callback) => {
    callback(null, 'original'); return handle;
  }, () => { throw new Error('diagnostic clock failed'); });
  assert.equal(badClock.execFile('ps', identity, settings, (error, stdout) => {
    callbacks++; assert.equal(error, null); assert.equal(stdout, 'original');
  }), handle);
  const badCode = new Error('private message');
  Object.defineProperty(badCode, 'code', { get() { throw new Error('diagnostic code getter failed'); } });
  const badRecord = createProcessQueryTimingDiagnostic((command, args, options, callback) => {
    callback(badCode, 'original'); return handle;
  });
  assert.equal(badRecord.execFile('ps', identity, settings, (error, stdout) => {
    callbacks++; assert.equal(error, badCode); assert.equal(stdout, 'original');
  }), handle);
  assert.equal(callbacks, 2);
});
