import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarkerIdentityConfirmationCapture } from './native-platform-marker-confirmations.mjs';

// Test Value Gate: reports must bound successful confirmation evidence without
// retaining arbitrary process data or accepting late callbacks after cleanup.
test('identity confirmation reports copy only bounded safe fields and stop with their command', () => {
  const capture = createMarkerIdentityConfirmationCapture();
  assert.equal(capture.snapshot(), undefined);
  const sample = { rootPid: 100, pid: 101, startTime: 'Fri Nov 13 07:48:09 2026',
    phase: 'post-marker-confirmation', queryStartedAt: 1000, queryCompletedAt: 1010,
    deadline: 2000, result: 'absent', command: 'private command', environment: 'private environment', marker: 'private marker' };
  capture.capture(sample);
  sample.pid = 999;
  for (let index = 0; index < 10; index++) capture.capture({ ...sample, pid: 200 + index });
  const snapshot = capture.snapshot();
  assert.equal(snapshot.records.length, 8);
  assert.equal(snapshot.omitted, 3);
  assert.equal(snapshot.records[0].pid, 101);
  assert(!JSON.stringify(snapshot).includes('private'));
  snapshot.records[0].pid = 555;
  assert.equal(capture.snapshot().records[0].pid, 101);
  capture.stop();
  const before = capture.snapshot();
  capture.capture(sample);
  assert.deepEqual(capture.snapshot(), before);
});
