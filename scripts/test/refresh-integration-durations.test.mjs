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
  const linuxJob = { ...job, platform: 'linux', shard: '1/1' };
  assert.deepEqual(parseIntegrationLog(lines.join('\n'), linuxJob),
    rows.map((row) => ({ ...row, ...linuxJob })));
  assert.throws(() => parseIntegrationLog(lines.slice(1).join('\n'), job), /2 passed.*1.*timing/u);
  assert.throws(() => parseIntegrationLog(lines.slice(0, 2).join('\n'), job), /Test Files/u);
  assert.throws(() => parseIntegrationLog(lines.filter((line) => !line.startsWith('↓')).join('\n'), job), /skipped file/u);
});

// Known file times on otherwise identical runner profiles. Fit the job speed
// using shared files; one slow file and 2x machine variation must not dominate.
function fixtureSamples() {
  const rows = [];
  for (const [runId, runIndex] of [['1', 0], ['2', 1], ['3', 2]]) {
    for (const [platform, count, jobOffset] of [['win32', runIndex === 0 ? 3 : 4, 0], ['darwin', 2, 4], ['linux', runIndex === 0 ? 1 : 2, 6]]) {
      const groups = platform === 'darwin' ? 2 : 3;
      for (let group = 1; group <= groups; group++) {
        for (const [name, standard] of [['a', 10], ['b', 6], ['c', 2]]) {
          // Keep the same files across topology changes but move some to the
          // new shard, just as in an actual historical/current comparison.
          const index = platform === 'linux' ? (count === 2 && group === 3 ? 2 : 1)
            : (count === 4 && group === 3 && name === 'c' ? 4 : group);
          const scale = platform === 'win32' && index === 1 ? [0.5, 1, 2][runIndex] : 1;
          const file = 'tests/integration/' + group + name + '.test.ts';
          rows.push({
            runId, jobId: String(Number(runId) * 10 + index + jobOffset),
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
  const { table, report, sourceCoverage } = calibrateDurations(rows, files);
  assert.deepEqual(table.sourceRuns, ['1', '2', '3']);
  assert.deepEqual(sourceCoverage, [
    { runId: '1', shards: { win32: 3, darwin: 2, linux: 1 } },
    { runId: '2', shards: { win32: 4, darwin: 2, linux: 2 } },
    { runId: '3', shards: { win32: 4, darwin: 2, linux: 2 } },
  ]);
  assert.equal(table.seconds.win32['tests/integration/1a.test.ts'], 10);
  assert.equal(table.seconds.win32['tests/integration/1b.test.ts'], 6);
  assert.equal(table.seconds.win32['tests/integration/1c.test.ts'], 2);
  assert.equal(table.seconds.darwin['tests/integration/2a.test.ts'], 10);
  assert.equal(table.seconds.linux['tests/integration/2a.test.ts'], 10);
  assert.ok(!Object.hasOwn(table.seconds.win32, newFile));
  assert.ok(!Object.hasOwn(table.seconds.win32, once));
  assert.ok(!Object.hasOwn(table.seconds.win32, removed));
  assert.deepEqual(report.win32.unmeasuredFiles.sort(), [newFile, once]);
  assert.ok(report.win32.ignoredFiles.includes(removed));
  for (const [platform, count] of [['win32', 4], ['darwin', 2], ['linux', 2]]) {
    assert.equal(report[platform].shards.length, count);
    assert.equal(report[platform].shards.reduce((total, shard) => total + shard.files, 0), files.length);
  }
});

test('partial runs and duplicate shard coverage cannot silently bias the profile', () => {
  const rows = fixtureSamples();
  const files = [...new Set(rows.map((row) => row.file))];
  assert.throws(() => calibrateDurations(rows.filter((row) => row.runId !== '1'), files), /3.*5.*runs/u);
  assert.throws(() => calibrateDurations(rows.filter((row) => row.jobId !== '11'), files), /missing.*win32.*1\/3/u);
  assert.throws(() => calibrateDurations([...rows, { ...rows[0], jobId: '12', shard: '2/3' }], files), /duplicate.*1a\.test\.ts/u);
  assert.throws(() => calibrateDurations(rows.filter((row) => row.platform !== 'linux'), files), /missing.*linux/u);
  assert.throws(() => calibrateDurations(rows.filter((row) => row.runId !== '2' || row.platform !== 'linux' || row.shard !== '2/2'), files), /missing.*linux.*2\/2/u);
  assert.throws(() => calibrateDurations([...rows, { ...rows[0], jobId: '19', shard: '4/4' }], files), /mixed shard counts.*win32/u);
  const linuxRow = rows.find((row) => row.platform === 'linux' && row.runId === '1');
  assert.throws(() => calibrateDurations([...rows, { ...linuxRow, jobId: '19', shard: '2/2' }], files), /mixed shard counts.*linux/u);
  assert.throws(() => calibrateDurations([...rows, { ...linuxRow, jobId: '19' }], files), /multiple jobs.*linux/u);
  assert.throws(() => calibrateDurations(rows.map((row) => row.jobId === '17' ? { ...row, jobId: '11' } : row), files), /duplicate job ID.*across shards or platforms/u);
});

// Split timing is temporary placement evidence, not an actual CI measurement.
// Old parent filenames are no longer discovered; an incomplete set of child
// observations cannot replace only half of the conserved historical weight.
test('refresh retains whole pending split groups per platform until all children are measured', () => {
  const parent = 'tests/integration/parent.test.ts';
  const childA = 'tests/integration/child-a.test.ts';
  const childB = 'tests/integration/child-b.test.ts';
  const resolvedParent = 'tests/integration/resolved-parent.test.ts';
  const resolvedChild = 'tests/integration/resolved-child.test.ts';
  const removedParent = 'tests/integration/removed-parent.test.ts';
  const removedChild = 'tests/integration/removed-child.test.ts';
  const platforms = ['win32', 'darwin', 'linux'];
  const prior = {
    sourceRuns: ['90', '91', '92'],
    seconds: Object.fromEntries(platforms.map((platform) => [platform, {
      [childA]: 30, [childB]: 70, [resolvedChild]: 50, [removedChild]: 15,
    }])),
    splitEstimates: {
      basis: 'Local relative observations',
      localSecondsByParent: {
        [parent]: { [childA]: 3, [childB]: 7 },
        [resolvedParent]: { [resolvedChild]: 5 },
        [removedParent]: { [removedChild]: 1.5 },
      },
    },
  };
  const base = fixtureSamples();
  const files = [...new Set(base.map((row) => row.file)), childA, childB, resolvedChild];
  const sample = (rows, job, entries) => rows.push(...Object.entries(entries)
    .map(([file, seconds]) => ({ ...job, file, seconds })));
  const stableJobs = base.filter((row) => row.file === 'tests/integration/2a.test.ts');
  const historical = [...base];
  for (const job of stableJobs) {
    sample(historical, job, { [parent]: 100, [resolvedParent]: 50 });
  }
  const oldRefresh = calibrateDurations(historical, files, prior);
  for (const platform of platforms) {
    assert.equal(oldRefresh.table.seconds[platform][childA], 30);
    assert.equal(oldRefresh.table.seconds[platform][childB], 70);
    assert.equal(oldRefresh.table.seconds[platform][resolvedChild], 50);
    assert.deepEqual(oldRefresh.report[platform].retainedEstimateFiles, [childA, childB, resolvedChild]);
    assert.ok(!Object.hasOwn(oldRefresh.table.seconds[platform], parent));
    assert.ok(!oldRefresh.report[platform].unmeasuredFiles.includes(childA));
  }
  assert.ok(!Object.hasOwn(oldRefresh.table.splitEstimates.localSecondsByParent, removedParent));
  assert.deepEqual(oldRefresh.table.sourceRuns, ['1', '2', '3']);
  assert.deepEqual(oldRefresh.table.splitEstimates.sourceRuns, ['90', '91', '92']);

  const mixed = [...base];
  for (const job of stableJobs) {
    sample(mixed, job, job.runId === '1' || job.platform === 'linux'
      ? { [parent]: 100 }
      : { [childA]: 12, ...(job.runId === '3' || job.platform === 'darwin' ? { [childB]: 8 } : {}) });
    sample(mixed, job, { [resolvedChild]: 4 });
  }
  const mixedRefresh = calibrateDurations(mixed, files, oldRefresh.table);
  for (const platform of ['win32', 'linux']) {
    // Windows has two actual child-a samples, but child-b has only one.
    // Linux has no child samples at all. Both conserve the entire estimate.
    assert.equal(mixedRefresh.table.seconds[platform][childA], 30);
    assert.equal(mixedRefresh.table.seconds[platform][childB], 70);
    assert.deepEqual(mixedRefresh.report[platform].retainedEstimateFiles, [childA, childB]);
  }
  assert.equal(mixedRefresh.table.seconds.darwin[childA], 12);
  assert.equal(mixedRefresh.table.seconds.darwin[childB], 8);
  assert.deepEqual(mixedRefresh.report.darwin.retainedEstimateFiles, []);
  assert.deepEqual(mixedRefresh.table.splitEstimates.sourceRuns, ['90', '91', '92']);
  assert.deepEqual(mixedRefresh.table.splitEstimates.localSecondsByParent, {
    [parent]: prior.splitEstimates.localSecondsByParent[parent],
  });
  for (const platform of platforms) {
    assert.equal(mixedRefresh.table.seconds[platform][resolvedChild], 4);
    assert.equal(mixedRefresh.report[platform].measuredFiles + mixedRefresh.report[platform].retainedEstimateFiles.length
      + mixedRefresh.report[platform].unmeasuredFiles.length, files.length);
  }

  const fullyObserved = [...base];
  for (const job of stableJobs) {
    sample(fullyObserved, job, { [childA]: 12, [childB]: 8, [resolvedChild]: 4 });
  }
  const complete = calibrateDurations(fullyObserved, files, mixedRefresh.table);
  assert.ok(!Object.hasOwn(complete.table, 'splitEstimates'));
  for (const platform of platforms) {
    assert.equal(complete.table.seconds[platform][childA], 12);
    assert.equal(complete.table.seconds[platform][childB], 8);
    assert.deepEqual(complete.report[platform].retainedEstimateFiles, []);
  }
});
