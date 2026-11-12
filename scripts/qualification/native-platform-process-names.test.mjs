import assert from 'node:assert/strict';
import test from 'node:test';
import { createProcessNameDiagnostic } from './native-platform-process-names.mjs';

const start = 'Thu Nov 12 08:00:49 2026';
const columns = ['-A', '-o', 'pid=,ppid=,pgid=,state=,lstart='];
const failure = (pid, reason = 'marked-process-group-changed') => [{ reason, affectedPids: [pid], processes: [{ pid, startTime: start }] }];

// Test Value Gate: private names must not become identity text, drop process
// rows, weaken errors, or retain argv/path data in the qualification report.
test('projects same-snapshot names to the original identity schema and preserves the query budget and handle', () => {
  const table = `100 1 100 S ${start} node\n101 100 100 S ${start} ps\n202 101 202 S ${start} git\n303 1 303 S ${start} unrelated\n`;
  const options = { timeout: 2000, windowsHide: true, maxBuffer: 1024 };
  const handle = {};
  const calls = [];
  const diagnostic = createProcessNameDiagnostic((command, args, received, callback) => {
    calls.push({ command, args }); assert.equal(received, options);
    callback(null, table, 'original-stderr'); return handle;
  });
  diagnostic.onSpawn({ pid: 100 });
  let callbacks = 0;
  assert.equal(diagnostic.execFile('ps', columns, options, (error, stdout, stderr) => {
    callbacks += 1; assert.equal(error, null); assert.equal(stderr, 'original-stderr');
    assert.equal(stdout, `100 1 100 S ${start}\n101 100 100 S ${start}\n202 101 202 S ${start}\n303 1 303 S ${start}\n`);
  }), handle);
  assert.equal(callbacks, 1);
  assert.deepEqual(calls, [{ command: 'ps', args: ['-A', '-o', `${columns[2]},ucomm=`] }]);
  assert.deepEqual(diagnostic.snapshot(failure(202)), [{ pid: 202, startTime: start, source: 'identity-ps-ucomm', processName: 'git' }]);
  assert.deepEqual(diagnostic.snapshot(failure(101, 'known-process-marker-missing')), [{ pid: 101, startTime: start, source: 'identity-ps-ucomm', processName: 'ps' }]);
  assert.deepEqual(diagnostic.snapshot(failure(303)), []);
  assert.deepEqual(diagnostic.snapshot([{ ...failure(202)[0], processes: [{ pid: 202, startTime: 'reused' }] }]), []);
  assert.deepEqual(diagnostic.snapshot([]), []);
});

test('rejects unsafe or missing names without changing any identity row', () => {
  for (const name of ['', 'has spaces', '/private/secret', 'git\u001b[31m', 'x'.repeat(33)]) {
    const diagnostic = createProcessNameDiagnostic((_command, _args, _options, callback) => {
      callback(null, `100 1 100 S ${start} node\n202 100 202 S ${start} ${name}\n`);
    });
    diagnostic.onSpawn({ pid: 100 });
    diagnostic.execFile('ps', columns, {}, (error, stdout) => {
      assert.equal(error, null); assert.equal(stdout, `100 1 100 S ${start}\n202 100 202 S ${start}\n`);
    });
    const hints = diagnostic.snapshot(failure(202));
    assert.equal(hints.length, 1); assert.equal(hints[0].processName, undefined);
    assert.equal(hints[0].unavailable, name ? 'name-rejected' : 'name-not-returned');
    assert(!JSON.stringify(hints).includes('private/secret'));
  }
});

test('does not turn query errors or malformed identity output into a successful empty tree', () => {
  for (const output of ['malformed sensitive output', `100 1 100 S ${start} node\nBROKEN\n`,
    `100 1 100 S ${start} node\n100 1 100 S ${start} duplicate\n`, undefined]) {
    const diagnostic = createProcessNameDiagnostic((_command, _args, _options, callback) => callback(null, output));
    diagnostic.execFile('ps', columns, {}, (error, stdout) => {
      assert.equal(error.message, 'qualification-identity-projection-failed'); assert.equal(stdout, '');
    });
  }
  for (const code of ['ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ENOENT']) {
    const original = Object.assign(new Error('original failure'), { code });
    const diagnostic = createProcessNameDiagnostic((_command, _args, _options, callback) => callback(original, 'partial private output', 'original-stderr'));
    diagnostic.execFile('ps', columns, {}, (error, stdout, stderr) => {
      assert.equal(error, original); assert.equal(stdout, ''); assert.equal(stderr, 'original-stderr');
    });
  }
});

test('keeps marker queries unchanged and bounds recent identity hints and final failure evidence', () => {
  let generation = 0;
  const diagnostic = createProcessNameDiagnostic((_command, args, _options, callback) => {
    if (args[0] !== '-A') { callback(null, 'unchanged marker output'); return; }
    const rows = Array.from({ length: 40 }, (_, index) => `${202 + index} 100 ${202 + index} S ${start} child${generation}`);
    callback(null, `100 1 100 S ${start} node\n${rows.join('\n')}\n`);
  });
  diagnostic.onSpawn({ pid: 100 });
  diagnostic.execFile('ps', columns, {}, (error) => assert.equal(error, null));
  const many = [{ reason: 'known-process-marker-missing', affectedPids: Array.from({ length: 40 }, (_, i) => i + 202),
    processes: Array.from({ length: 40 }, (_, i) => ({ pid: i + 202, startTime: start })) }];
  assert.equal(diagnostic.snapshot(many).length, 8);
  assert.deepEqual(diagnostic.snapshot(failure(202)), []);
  const before = diagnostic.snapshot(failure(241));
  diagnostic.stop(); generation += 1;
  diagnostic.execFile('ps', columns, {}, (error, stdout) => { assert.equal(error, null); assert(!stdout.includes('child1')); });
  assert.deepEqual(diagnostic.snapshot(failure(241)), before);
  diagnostic.execFile('ps', ['eww', '-A', '-o', 'pid=,command='], {}, (error, stdout) => {
    assert.equal(error, null); assert.equal(stdout, 'unchanged marker output');
  });
});
