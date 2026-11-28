import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { calibrateDurations, formatTimingsTsv, parseIntegrationLog, parseTimingsTsv, readCiRuns, readCiSampleJobs, readLogDirectory } from '../../packages/cli/scripts/refresh-integration-durations.mjs';

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
  for (const [platform, count] of [['win32', 6], ['darwin', 2], ['linux', 2]]) {
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

// Exercise the actual collection interface at the external gh boundary. Job and
// attempt fields use GitHub's REST shape; different attempts of one run must
// retain independent identities all the way through logs and calibration.
function attemptFixture() {
  const headSha = 'a'.repeat(40);
  const names = [
    'win32 x64 / Node 24 / integration 1 of 6', 'win32 x64 / Node 24 / integration 2 of 6',
    'win32 x64 / Node 24 / integration 3 of 6', 'win32 x64 / Node 24 / integration 4 of 6',
    'win32 x64 / Node 24 / integration 5 of 6', 'win32 x64 / Node 24 / integration 6 of 6',
    'darwin arm64 / Node 24 / integration 1 of 2', 'darwin arm64 / Node 24 / integration 2 of 2',
    'Linux x64 / Node 24 / integration 1 of 2', 'Linux x64 / Node 24 / integration 2 of 2',
    'Linux x64 / Node 24 / unit', 'beta',
  ];
  const metadata = new Map();
  const jobs = new Map();
  const logs = new Map();
  for (const [runId, attempt] of [[77, 1], [77, 2], [77, 3], [88, 1]]) {
    const key = runId + '@' + attempt;
    const start = Date.UTC(2026, 10, 27, 12, attempt);
    metadata.set(key, {
      id: runId, run_attempt: attempt, status: 'completed', conclusion: 'success',
      path: '.github/workflows/ci.yml', head_sha: headSha, run_started_at: new Date(start).toISOString(),
    });
    jobs.set(key, names.map((name, index) => {
      const id = runId * 10000 + attempt * 100 + index;
      logs.set(String(id), {
        runId: String(runId), attempt: String(attempt),
        log: '✓ integration tests/integration/file-' + index + '.test.ts (1 test) 10ms\n Test Files  1 passed (1)\n',
      });
      return {
        id, name, run_id: runId, run_attempt: attempt, head_sha: headSha,
        status: 'completed', conclusion: name === 'beta' ? 'skipped' : 'success',
        started_at: name === 'beta' ? null : new Date(start + 1000).toISOString(),
        completed_at: name === 'beta' ? null : new Date(start + 2000).toISOString(),
      };
    }));
  }
  function invokeGh(args) {
    if (args[0] === 'api') {
      const [, runId, attempt, listJobs] = /\/runs\/(\d+)(?:\/attempts\/(\d+)(\/jobs\?per_page=100)?)?$/u.exec(args[3]);
      if (!attempt) return JSON.stringify(metadata.get(runId + '@' + (runId === '77' ? '3' : '1')));
      const key = runId + '@' + attempt;
      if (!listJobs) return JSON.stringify(metadata.get(key));
      const sampleJobs = jobs.get(key);
      // Include two pages so accidentally truncating the attempt job list
      // cannot pass just because the fixture fits in one page.
      return JSON.stringify([
        { total_count: sampleJobs.length, jobs: sampleJobs.slice(0, 4) },
        { total_count: sampleJobs.length, jobs: sampleJobs.slice(4) },
      ]);
    }
    const jobId = args[args.indexOf('--job') + 1];
    const log = logs.get(jobId);
    assert.equal(args[2], log.runId);
    assert.equal(args[args.indexOf('--attempt') + 1], log.attempt);
    return log.log;
  }
  return { metadata, jobs, invokeGh };
}

test('exact successful attempts of one run and legacy remote IDs retain distinct sample provenance', () => {
  const fixture = attemptFixture();
  const rows = readCiRuns(['77@1', '77@2', '77@3', '88'], fixture.invokeGh);
  assert.deepEqual(parseTimingsTsv(formatTimingsTsv(rows)), rows);
  const files = [...new Set(rows.map((row) => row.file))];
  const { table, report, sourceCoverage } = calibrateDurations(rows, files);
  assert.deepEqual(table.sourceRuns, ['77@1', '77@2', '77@3', '88@1']);
  assert.equal(report.win32.normalizationFactors.length, 24);
  for (const sample of sourceCoverage) {
    assert.deepEqual(sample.shards, { win32: 6, darwin: 2, linux: 2 });
  }
});

test('full reruns may expand an initially skipped reusable workflow into fresh descendant jobs', () => {
  const fixture = attemptFixture();
  const beta = fixture.jobs.get('77@2').find((job) => job.name === 'beta');
  const fresh = fixture.jobs.get('77@2').find((job) => job.name.endsWith('/ unit'));
  Object.assign(beta, {
    name: 'beta / candidates', conclusion: 'success',
    started_at: fresh.started_at, completed_at: fresh.completed_at,
  });
  assert.equal(readCiSampleJobs('77@2', fixture.invokeGh).jobs.length, 10);
  beta.started_at = fixture.jobs.get('77@1')[0].started_at;
  beta.completed_at = fixture.jobs.get('77@1')[0].completed_at;
  assert.throws(() => readCiSampleJobs('77@2', fixture.invokeGh), /reused or invalid job execution times/u);
  beta.started_at = fresh.started_at;
  beta.completed_at = fresh.completed_at;
  fresh.name += ' / unexpected descendant';
  assert.throws(() => readCiSampleJobs('77@2', fixture.invokeGh), /partial rerun/u);
});

test('attempt collection rejects composite, partial, unsuccessful and duplicate evidence', () => {
  const request = (keys, fixture) => readCiRuns(keys, fixture.invokeGh);
  const keys = ['77@1', '77@2', '77@3'];
  const fixture = attemptFixture();
  assert.throws(() => request(['77@1', '77@1', '77@3'], fixture), /distinct/u);
  assert.throws(() => request(['77', '77@1', '77@2'], fixture), /mix bare and explicit/u);
  assert.throws(() => request(['77@01', '77@2', '77@3'], fixture), /distinct RUN_ID/u);

  const failed = attemptFixture();
  failed.metadata.get('77@2').conclusion = 'failure';
  assert.throws(() => request(keys, failed), /not a successful ci\.yml attempt/u);

  const wrongAttempt = attemptFixture();
  wrongAttempt.jobs.get('77@2')[0].run_attempt = 1;
  assert.throws(() => request(keys, wrongAttempt), /mismatched attempt jobs/u);

  const copied = attemptFixture();
  // GitHub can copy a previous successful execution into a partial rerun
  // with entirely new job IDs and the current run_attempt.
  const previous = copied.jobs.get('77@1').find((job) => job.name.endsWith('/ unit'));
  const inherited = copied.jobs.get('77@2').find((job) => job.name.endsWith('/ unit'));
  inherited.started_at = previous.started_at;
  inherited.completed_at = previous.completed_at;
  assert.throws(() => request(keys, copied), /reused or invalid job execution times/u);

  const missingTimes = attemptFixture();
  missingTimes.jobs.get('77@2')[0].completed_at = null;
  assert.throws(() => request(keys, missingTimes), /reused or invalid job execution times/u);
  const reversedTimes = attemptFixture();
  reversedTimes.jobs.get('77@2')[0].completed_at = reversedTimes.metadata.get('77@2').run_started_at;
  assert.throws(() => request(keys, reversedTimes), /reused or invalid job execution times/u);
  const missingStart = attemptFixture();
  missingStart.metadata.get('77@2').run_started_at = null;
  assert.throws(() => request(keys, missingStart), /missing valid attempt start/u);

  const partial = attemptFixture();
  partial.jobs.set('77@2', partial.jobs.get('77@2').filter((job) => !job.name.endsWith('/ unit'))); // Timing matrix itself still complete.
  assert.throws(() => request(keys, partial), /partial rerun/u);
  const missing = attemptFixture();
  missing.jobs.get('77@1').splice(5, 1);
  assert.throws(() => readCiSampleJobs('77@1', missing.invokeGh), /missing.*win32.*6\/6/u);

  const reusedId = attemptFixture();
  reusedId.jobs.get('77@2')[0].id = reusedId.jobs.get('77@1')[0].id;
  assert.throws(() => request(keys, reusedId), /Duplicate job IDs across CI samples/u);
});

test('local logs and TSV preserve qualified samples and reject overlapping attempts or reused jobs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-timing-attempts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = fixtureSamples().map((row) => ({ ...row, runId: row.runId === '1' ? '1' : '77@' + row.runId }));
  const files = [...new Set(rows.map((row) => row.file))];
  for (const row of rows) {
    const logName = [row.runId, row.jobId, row.platform, row.shard.replace('/', '-of-')].join('-') + '.log';
    const logPath = path.join(root, logName);
    fs.appendFileSync(logPath, '✓ integration ' + row.file + ' (1 test) ' + row.seconds + 's\n');
  }
  for (const log of fs.readdirSync(root)) {
    const logPath = path.join(root, log);
    const count = fs.readFileSync(logPath, 'utf8').trim().split('\n').length;
    fs.appendFileSync(logPath, ' Test Files  ' + count + ' passed (' + count + ')\n');
  }
  const parsed = readLogDirectory(root);
  assert.deepEqual(calibrateDurations(parsed, files).table, calibrateDurations(rows, files).table);
  assert.deepEqual(calibrateDurations(parseTimingsTsv(formatTimingsTsv(rows)), files).table.sourceRuns,
    ['1', '77@2', '77@3']);
  assert.throws(() => calibrateDurations(rows.map((row) => row.runId === '1' ? { ...row, runId: '77' } : row), files), /mix bare and explicit/u);
  assert.throws(() => calibrateDurations(rows.map((row) => row.jobId === '21' ? { ...row, jobId: '11' } : row), files), /duplicate job ID.*across samples/u);
  assert.throws(() => calibrateDurations(rows.filter((row) => row.jobId !== '24'), files), /missing.*win32.*4\/4/u);
});
