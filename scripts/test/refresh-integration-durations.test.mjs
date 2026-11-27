import assert from 'node:assert/strict';
import { test } from 'node:test';

import { calibrateDurations, formatTimingsTsv, parseIntegrationLog, parseTimingsTsv } from '../../packages/cli/scripts/refresh-integration-durations.mjs';

// Protect the evidence boundary: partially skipped test files still ran, while
// later serial steps must not contribute to ordinary integration weights.
test('successful job logs account for every passed integration file, including partially skipped files', () => {
  const job = { runId: '1', jobId: '11', platform: 'win32', shard: '3/3' };
  const lines = [
    'job\tUNKNOWN STEP\t2026-11-26T15:32:07.5485068Z  ^[[32m✓^[[39m ^[[30m^[[45m integration ^[[49m^[[39m tests/integration/a.test.ts (45 tests) 193947ms',
    '\u001b[32m✓\u001b[39m integration tests\\integration\\b.test.tsx (24 tests | 1 skipped) 5421ms',
    '↓ integration tests/integration/skip.test.tsx (2 tests | 2 skipped)',
    ' Test Files  2 passed | 1 skipped (3)',
    '✓ process-lifecycle tests/integration/serial.test.ts (1 test) 12ms',
    ' Test Files  1 passed (1)',
  ];
  const rows = parseIntegrationLog(lines.join('\n'), job);
  assert.deepEqual(rows, [
    { ...job, file: 'tests/integration/a.test.ts', seconds: 193.947 },
    { ...job, file: 'tests/integration/b.test.tsx', seconds: 5.421 },
  ]);
  assert.deepEqual(parseTimingsTsv(formatTimingsTsv(rows)), rows);
  assert.throws(() => parseIntegrationLog(lines.slice(1).join('\n'), job), /2 passed.*1.*timing/u);
  assert.throws(() => parseIntegrationLog(lines.slice(0, 2).join('\n'), job), /Test Files/u);
  assert.throws(() => parseIntegrationLog(lines.filter((line) => !line.startsWith('↓')).join('\n'), job), /skipped file/u);
});

// Known file times on otherwise identical runner profiles. Fit the job speed
// using shared files; one slow file and 2x machine variation must not dominate.
function fixtureSamples() {
  const rows = [];
  for (const [runId, runIndex] of [['1', 0], ['2', 1], ['3', 2]]) {
    for (const [platform, count] of [['win32', 3], ['darwin', 2]]) {
      for (let index = 1; index <= count; index++) {
        const scale = platform === 'win32' && index === 1 ? [0.5, 1, 2][runIndex] : 1;
        for (const [name, standard] of [['a', 10], ['b', 6], ['c', 2]]) {
          const file = 'tests/integration/' + index + name + '.test.ts';
          rows.push({
            runId, jobId: String(Number(runId) * 10 + (platform === 'win32' ? index : index + 3)),
            platform, shard: index + '/' + count, file,
            seconds: standard * scale * (platform === 'win32' && index === 1 && name === 'a' && runIndex === 2 ? 10 : 1),
          });
        }
      }
    }
  }
  return rows;
}

test('job speed normalization uses multiple runs and reports discovery gaps without fabricating measurements', () => {
  const rows = fixtureSamples();
  const names = [...new Set(rows.map((row) => row.file))];
  const newFile = 'tests/integration/new.test.tsx';
  const once = 'tests/integration/once.test.ts';
  rows.push({ ...rows[0], file: once, seconds: 1 });
  // Removed files are observed, but do not take part in the current partition.
  const removed = names.pop();
  const files = [...names, newFile, once];
  const { table, report } = calibrateDurations(rows, files);
  assert.deepEqual(table.sourceRuns, ['1', '2', '3']);
  assert.equal(table.seconds.win32['tests/integration/1a.test.ts'], 10);
  assert.equal(table.seconds.win32['tests/integration/1b.test.ts'], 6);
  assert.equal(table.seconds.win32['tests/integration/1c.test.ts'], 2);
  assert.equal(table.seconds.darwin['tests/integration/2a.test.ts'], 10);
  assert.ok(!Object.hasOwn(table.seconds.win32, newFile));
  assert.ok(!Object.hasOwn(table.seconds.win32, once));
  assert.ok(!Object.hasOwn(table.seconds.win32, removed));
  assert.deepEqual(report.win32.unmeasuredFiles.sort(), [newFile, once]);
  assert.ok(report.win32.ignoredFiles.includes(removed));
  assert.equal(report.win32.shards.reduce((total, shard) => total + shard.files, 0), files.length);
  assert.equal(report.darwin.shards.reduce((total, shard) => total + shard.files, 0), files.length);
});

test('partial runs and duplicate shard coverage cannot silently bias the profile', () => {
  const rows = fixtureSamples();
  const files = [...new Set(rows.map((row) => row.file))];
  assert.throws(() => calibrateDurations(rows.filter((row) => row.runId !== '1'), files), /3.*5.*runs/u);
  assert.throws(() => calibrateDurations(rows.filter((row) => row.jobId !== '11'), files), /missing.*win32.*1\/3/u);
  assert.throws(() => calibrateDurations([...rows, { ...rows[0], jobId: '12', shard: '2/3' }], files), /duplicate.*1a\.test\.ts/u);
});
