import assert from 'node:assert/strict';
import test from 'node:test';
import { createProcessNameDiagnostic } from './native-platform-process-names.mjs';

// Test Value Gate: private process names must stay a bounded identity-matched
// failure hint; queries cannot change observer results or retain argv/path data.
test('captures only matching owned process names without changing the identity callback', () => {
  const start = 'Thu Nov 12 08:00:49 2026';
  const columns = ['-A', '-o', 'pid=,ppid=,pgid=,state=,lstart='];
  const table = `100 1 100 S ${start}\n101 100 100 S ${start}\n202 101 202 S ${start}\n303 1 303 S ${start}\n`;
  const queries = [];
  const handle = {};
  let observerError;
  const diagnostic = createProcessNameDiagnostic((command, args, options, callback) => {
    if (args[0] === '-A') { callback(observerError ?? null, table, 'unchanged-stderr'); return handle; }
    queries.push({ command, args, options });
    callback(null, `202 ${start} git\n303 ${start} unrelated\n`);
    return { kill() {} };
  });
  diagnostic.onSpawn({ pid: 100 });
  const options = { timeout: 2000, windowsHide: true, maxBuffer: 1024 };
  let calls = 0;
  const original = (error, stdout, stderr) => {
    calls += 1; assert.equal(error, observerError ?? null); assert.equal(stdout, table); assert.equal(stderr, 'unchanged-stderr');
  };
  assert.equal(diagnostic.execFile('ps', columns, options, original), handle);
  diagnostic.execFile('ps', columns, options, original);
  observerError = new Error('original lookup failure');
  diagnostic.execFile('ps', columns, options, original);
  assert.equal(calls, 3);
  assert.deepEqual(queries, [{ command: 'ps', args: ['-p', '202', '-o', 'pid=,lstart=,ucomm='],
    options: { timeout: 100, windowsHide: true, maxBuffer: 4096 } }]);
  const failure = [{ reason: 'marked-process-group-changed', affectedPids: [202], processes: [{ pid: 202, startTime: start }] }];
  assert.deepEqual(diagnostic.snapshot(failure), [{ pid: 202, startTime: start, source: 'ps-ucomm', processName: 'git' }]);
  assert.deepEqual(diagnostic.snapshot([{ ...failure[0], processes: [{ pid: 202, startTime: 'different identity' }] }]), []);
  assert.deepEqual(diagnostic.snapshot([]), []);
  diagnostic.stop();
});

test('process name hints reject stale identities, unsafe text and diagnostic failures', () => {
  const start = 'Thu Nov 12 08:00:49 2026';
  const table = `100 1 100 S ${start}\n202 100 202 S ${start}\n`;
  for (const [label, output] of [['path', `/private/secret`], ['control', 'git\u001b[31m'],
    ['long', 'x'.repeat(33)], ['timeout', null], ['throw', undefined], ['oversize', 'x'.repeat(4097)],
    ['reused-pid', 'safe-name']]) {
    let calls = 0;
    const diagnostic = createProcessNameDiagnostic((_command, args, _options, callback) => {
      if (args[0] === '-A') { callback(null, table); return; }
      if (label === 'throw') throw new Error('private diagnostic error');
      callback(label === 'timeout' ? new Error('timeout with private text') : null,
        label === 'oversize' ? output : `202 ${label === 'reused-pid' ? 'Thu Nov 12 08:00:50 2026' : start} ${output}\n`);
      return { kill() {} };
    });
    diagnostic.onSpawn({ pid: 100 });
    diagnostic.execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,state=,lstart='], {}, (error, stdout) => {
      calls += 1; assert.equal(error, null); assert.equal(stdout, table);
    });
    assert.equal(calls, 1, label);
    const result = diagnostic.snapshot([{ reason: 'marked-process-group-changed', affectedPids: [202],
      processes: [{ pid: 202, knownStartTime: start }] }]);
    assert.equal(result.length, 1, label);
    assert.equal(result[0].processName, undefined, label);
    assert.equal(typeof result[0].unavailable, 'string', label);
    assert(!JSON.stringify(result).includes('private diagnostic error'));
    diagnostic.stop();
  }
});

test('process name queries stay bounded and late results cannot change a stopped report', () => {
  const start = 'Thu Nov 12 08:00:49 2026';
  const table = `100 1 100 S ${start}\n${Array.from({ length: 12 }, (_, n) => `${202 + n} 100 ${202 + n} S ${start}`).join('\n')}`;
  let queryCallback;
  let queryCount = 0;
  let killed = 0;
  const diagnostic = createProcessNameDiagnostic((_command, args, _options, callback) => {
    if (args[0] === '-A') { callback(null, table); return; }
    queryCount += 1; assert.equal(args[1], '202,203,204,205,206,207,208,209'); queryCallback = callback;
    return { kill(signal) { assert.equal(signal, 'SIGKILL'); killed += 1; } };
  });
  diagnostic.onSpawn({ pid: 100 });
  for (let n = 0; n < 3; n += 1) diagnostic.execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,state=,lstart='], {}, () => {});
  assert.equal(queryCount, 1);
  const failure = [{ reason: 'marked-process-group-changed', affectedPids: [202], processes: [{ pid: 202, startTime: start }] }];
  const before = diagnostic.snapshot(failure);
  diagnostic.stop();
  queryCallback(null, `202 ${start} git\n`);
  assert.deepEqual(diagnostic.snapshot(failure), before);
  assert.equal(killed, 1);
});

