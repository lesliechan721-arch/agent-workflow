import assert from 'node:assert/strict';
import test from 'node:test';
import { createProcessNameDiagnostic, createProcessMarkerRowDiagnostic } from './native-platform-process-names.mjs';

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

const markerColumns = ['eww', '-A', '-o', `${columns[2]},command=`];
const markerFailure = (pids) => [{ rootPid: 100, reason: 'initial-group-marker-missing',
  capturedAt: new Date(Date.now() + 1000).toISOString(), affectedPids: pids,
  processes: pids.map((pid) => ({ pid, startTime: start })) }];

// Test Value Gate: retain the missing original row shape without recording its
// command/environment, or changing the callback used for the real verdict.
test('retains bounded marker row shapes and identity while forwarding the original query unchanged', () => {
  const stdout = `100 1 100 S ${start} node PUBLIC=private-marker\n`
    + `202 100 100 R ${start} [private-name]\n`
    + `203 202 203 S ${start} /private/command PUBLIC=wrong-private-marker\n`
    + `303 1 303 S ${start} unrelated-private-data\n`;
  const options = { timeout: 2000, maxBuffer: 2048 };
  const handle = {};
  let calls = 0;
  const diagnostic = createProcessMarkerRowDiagnostic((command, args, received, callback) => {
    calls += 1; assert.equal(command, 'ps'); assert.equal(args, markerColumns); assert.equal(received, options);
    callback(null, stdout, 'private-stderr'); return handle;
  });
  diagnostic.onSpawn({ pid: 100 }); diagnostic.setMarker('PUBLIC', 'private-marker');
  assert.equal(diagnostic.execFile('ps', markerColumns, options, (error, output, stderr) => {
    assert.equal(error, null); assert.equal(output, stdout); assert.equal(stderr, 'private-stderr');
  }), handle);
  assert.equal(calls, 1);
  const rows = diagnostic.snapshot(markerFailure([100, 202, 203, 303]));
  assert.deepEqual(rows.map(({ pid, commandForm, markerAssignmentPresent }) => ({ pid, commandForm, markerAssignmentPresent })),
    [{ pid: 202, commandForm: 'bracketed', markerAssignmentPresent: false },
      { pid: 203, commandForm: 'other', markerAssignmentPresent: true }]);
  assert(rows.every((row) => row.startTime === start && row.queryId === 1 && row.source === 'original-marker-ps-row-shape'));
  assert(rows.every((row) => Number.isFinite(Date.parse(row.queryStartedAt)) && Number.isFinite(Date.parse(row.queryCallbackAt))));
  assert(!JSON.stringify(rows).includes('private'));
  assert.deepEqual(diagnostic.snapshot([{ ...markerFailure([202])[0], processes: [{ pid: 202, startTime: 'reused' }] }]), []);
  assert.deepEqual(diagnostic.snapshot([{ ...markerFailure([202])[0], capturedAt: '1970-01-01T00:00:00Z' }]), []);
  assert.deepEqual(diagnostic.snapshot([{ ...markerFailure([202])[0], rootPid: 999 }]), []);
});

test('marker shape diagnostics leave errors, malformed queries and unrelated calls unchanged', () => {
  for (const output of ['malformed private output',
    `100 1 100 private-state ${start} hidden\n`,
    `100 1 100 S ${start} node\n100 1 100 S ${start} duplicate\n`, undefined]) {
    const diagnostic = createProcessMarkerRowDiagnostic((_command, _args, _options, callback) => callback(null, output));
    diagnostic.onSpawn({ pid: 100 }); diagnostic.setMarker('PUBLIC', 'marker');
    diagnostic.execFile('ps', markerColumns, {}, (error, stdout) => { assert.equal(error, null); assert.equal(stdout, output); });
    assert.deepEqual(diagnostic.snapshot(markerFailure([100])), []);
  }
  const original = new Error('private error');
  const diagnostic = createProcessMarkerRowDiagnostic((_command, _args, _options, callback) => callback(original, 'partial private output'));
  diagnostic.execFile('ps', markerColumns, {}, (error, stdout) => { assert.equal(error, original); assert.equal(stdout, 'partial private output'); });
  assert.deepEqual(diagnostic.snapshot(markerFailure([100])), []);
  let invoked = 0;
  const unrelated = createProcessMarkerRowDiagnostic((command, args, options, callback) => {
    invoked += 1; assert.equal(command, 'other'); assert.deepEqual(args, []); assert.deepEqual(options, {});
    callback(null, 'unchanged'); return 'handle';
  });
  assert.equal(unrelated.execFile('other', [], {}, (_error, stdout) => assert.equal(stdout, 'unchanged')), 'handle');
  assert.equal(invoked, 1);
});

test('marks unparsed continuation lines without retaining them or changing the original output', () => {
  const stdout = `100 1 100 S ${start} node PUBLIC=marker\nprivate-multiline-continuation\n202 100 100 R ${start} [hidden]\n`;
  const diagnostic = createProcessMarkerRowDiagnostic((_command, _args, _options, callback) => callback(null, stdout));
  diagnostic.onSpawn({ pid: 100 }); diagnostic.setMarker('PUBLIC', 'marker');
  diagnostic.execFile('ps', markerColumns, {}, (error, value) => { assert.equal(error, null); assert.equal(value, stdout); });
  const rows = diagnostic.snapshot(markerFailure([202]));
  assert.equal(rows.length, 1); assert.equal(rows[0].unparsedLines, 1); assert.equal(rows[0].commandForm, 'bracketed');
  assert(!JSON.stringify(rows).includes('private'));
});

test('marker row forms, cache/output limits and stop never change original stdout', () => {
  let stdout = `100 1 100 S ${start} node PUBLIC=marker\n`;
  const forms = ['', '<defunct>', '(private)', '[private]', 'private-ordinary', '[private] <defunct>'];
  stdout += forms.map((form, i) => `${202 + i} 100 100 S ${start} ${form}`).join('\n') + '\n';
  const diagnostic = createProcessMarkerRowDiagnostic((_command, _args, _options, callback) => callback(null, stdout));
  diagnostic.onSpawn({ pid: 100 }); diagnostic.setMarker('PUBLIC', 'marker');
  const query = () => diagnostic.execFile('ps', markerColumns, {}, (error, output) => {
    assert.equal(error, null); assert.equal(output, stdout);
  });
  query();
  assert.deepEqual(diagnostic.snapshot(markerFailure([202, 203, 204, 205, 206, 207])).map((row) => row.commandForm),
    ['empty', 'defunct', 'parenthesized', 'bracketed', 'other', 'bracketed-defunct']);
  stdout = `100 1 100 S ${start} node PUBLIC=marker\n`
    + Array.from({ length: 40 }, (_, i) => `${400 + i} 100 100 R ${start} hidden`).join('\n') + '\n';
  query();
  assert.deepEqual(diagnostic.snapshot(markerFailure([202, 400])), []);
  assert.equal(diagnostic.snapshot(markerFailure(Array.from({ length: 40 }, (_, i) => 400 + i))).length, 8);
  const before = diagnostic.snapshot(markerFailure([439]));
  diagnostic.stop(); stdout = `100 1 100 S ${start} node PUBLIC=marker\n439 100 100 R ${start} [changed]\n`; query();
  assert.deepEqual(diagnostic.snapshot(markerFailure([439])), before);
});

test('keeps multiple same-identity query candidates explicitly ambiguous', () => {
  let form = '[first-private]';
  const diagnostic = createProcessMarkerRowDiagnostic((_command, _args, _options, callback) =>
    callback(null, `100 1 100 S ${start} node PUBLIC=marker\n202 100 100 R ${start} ${form}\n`));
  diagnostic.onSpawn({ pid: 100 }); diagnostic.setMarker('PUBLIC', 'marker');
  diagnostic.execFile('ps', markerColumns, {}, () => {});
  form = 'second-private'; diagnostic.execFile('ps', markerColumns, {}, () => {});
  const rows = diagnostic.snapshot(markerFailure([202]));
  assert.deepEqual(rows.map((row) => row.commandForm), ['bracketed', 'other']);
  assert(rows.every((row) => row.queryCandidateCount === 2 && row.association.startsWith('ambiguous-query')));
  assert(!JSON.stringify(rows).includes('private'));
});
