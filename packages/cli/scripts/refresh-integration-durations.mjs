import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';

import { partitionByDuration } from './integration-sequencer.mjs';

const cliRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = path.resolve(cliRoot, '../..');
const shardCounts = { win32: 6, darwin: 2, linux: 2 };
const acceptedCounts = { win32: [3, 4, 6], darwin: [2], linux: [1, 2] };
const jobPrefixes = { win32: 'win32 x64', darwin: 'darwin arm64', linux: 'Linux x64' };
const timingHeader = 'run_id\tjob_id\tplatform\tshard\tfile\tseconds';
const integrationFile = /^tests\/integration\/.+\.test\.tsx?$/u;

function positiveId(id) {
  return /^[1-9]\d*$/u.test(id);
}

// The existing run_id TSV column carries the sample identity. Bare historic
// local samples remain valid, but cannot overlap an explicit attempt.
function sampleIdentity(key) {
  return /^([1-9]\d*)(?:@([1-9]\d*))?$/u.exec(key);
}

function validateSampleKeys(keys) {
  if (keys.some((key) => !sampleIdentity(key)) || new Set(keys).size !== keys.length) {
    throw new Error('Sample IDs must be distinct RUN_ID or RUN_ID@ATTEMPT values.');
  }
  for (const [runId, samples] of groupBy(keys, (key) => sampleIdentity(key)[1])) {
    if (samples.includes(runId) && samples.length > 1) {
      throw new Error('Cannot mix bare and explicit attempt IDs for run ' + runId);
    }
  }
  if (keys.length < 3 || keys.length > 5) throw new Error('Provide 3–5 distinct successful CI runs or attempts.');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validateRow(row) {
  const { runId, jobId, platform, shard, file, seconds } = row;
  if (!sampleIdentity(runId) || !positiveId(jobId) || !Object.hasOwn(acceptedCounts, platform)
    || !acceptedCounts[platform].some((count) => Array.from({ length: count }, (_, index) => (index + 1) + '/' + count).includes(shard))
    || !integrationFile.test(file) || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Invalid timing row: ' + JSON.stringify(row));
  }
}

export function parseIntegrationLog(log, job) {
  const rows = [];
  let skipped = 0;
  let passed;
  let summarySkipped;
  for (const raw of log.split(/\r?\n/u)) {
    // gh can return either ANSI control bytes or caret-escaped SGR sequences.
    const line = stripVTControlCharacters(raw).replace(/\^\[\[[\d;]*m/gu, '')
      .replace(/^(?:[^\t]+\t[^\t]+\t)?\d{4}-\d{2}-\d{2}T\S+\s*/u, '').trim();
    const file = /^✓\s+integration\s+(tests[/\\]integration[/\\].+?\.test\.tsx?)\s+\(\d+\s+tests?(?:\s+\|[^)]*)?\)\s+([\d.]+)\s*(ms|s)$/u.exec(line);
    if (file) {
      const row = {
        ...job, file: file[1].replaceAll('\\', '/'),
        seconds: Number(file[2]) / (file[3] === 'ms' ? 1000 : 1),
      };
      validateRow(row);
      rows.push(row);
    } else if (/^↓\s+integration\s+tests[/\\]integration[/\\].+?\.test\.tsx?\s+\(\d+\s+tests?\s+\|\s+\d+\s+skipped\)$/u.test(line)) {
      skipped++;
    } else if (rows.length && line.startsWith('Test Files')) {
      // The integration step ends here. The final shard subsequently runs separate
      // process-lifecycle and diagnostic tests which must not enter the table.
      const summary = /^Test Files\s+(\d+)\s+passed(?:\s+\|\s+(\d+)\s+skipped)?\s+\((\d+)\)$/u.exec(line);
      if (summary) {
        passed = Number(summary[1]);
        summarySkipped = Number(summary[2] ?? 0);
        if (passed + summarySkipped !== Number(summary[3])) throw new Error('Invalid Test Files summary: ' + line);
      }
      break;
    }
  }
  const context = job.runId + ' / ' + job.platform + ' ' + job.shard;
  if (passed === undefined) throw new Error(context + ': missing successful Test Files summary.');
  if (passed !== rows.length) {
    throw new Error(context + ': ' + passed + ' passed files but ' + rows.length + ' timing rows.');
  }
  if (summarySkipped !== skipped) throw new Error(context + ': incomplete skipped file summaries.');
  return rows;
}

export function parseTimingsTsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/u);
  if (header !== timingHeader) throw new Error('Unexpected timings TSV header.');
  return lines.map((line) => {
    const fields = line.split('\t');
    if (fields.length !== 6) throw new Error('Invalid timing TSV row: ' + line);
    const [runId, jobId, platform, shard, file, seconds] = fields;
    const row = { runId, jobId, platform, shard, file: file.replaceAll('\\', '/'), seconds: Number(seconds) };
    validateRow(row);
    return row;
  });
}

export function formatTimingsTsv(rows) {
  return [timingHeader, ...rows.map(({ runId, jobId, platform, shard, file, seconds }) =>
    [runId, jobId, platform, shard, file, seconds].join('\t'))].join('\n') + '\n';
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

// Each source run must contain a full matrix. Historical and current counts
// may coexist across runs, but never within one platform of a single run.
function validateTopology(runId, platform, jobs) {
  const counts = new Set(jobs.map((job) => Number(job.shard.split('/')[1])));
  if (counts.size > 1) throw new Error(runId + ': mixed shard counts for ' + platform);
  const count = [...counts][0];
  if (!acceptedCounts[platform].includes(count)) {
    throw new Error(runId + ': missing or unsupported shard count for ' + platform);
  }
  const ids = new Set();
  for (let index = 1; index <= count; index++) {
    const shard = index + '/' + count;
    const matches = jobs.filter((job) => job.shard === shard);
    if (!matches.length) throw new Error(runId + ': missing ' + platform + ' ' + shard);
    if (matches.length !== 1 || ids.has(matches[0].jobId)) {
      throw new Error(runId + ': multiple jobs or duplicate job ID for ' + platform + ' ' + shard);
    }
    ids.add(matches[0].jobId);
  }
  if (jobs.length !== count) throw new Error(runId + ': invalid shards for ' + platform);
  return count;
}

function validateRuns(rows) {
  for (const row of rows) validateRow(row);
  const runs = groupBy(rows, (row) => row.runId);
  validateSampleKeys([...runs.keys()]);
  const sourceCoverage = [];
  const jobOwners = new Map();
  for (const [runId, runRows] of runs) {
    const shards = {};
    for (const platform of Object.keys(shardCounts)) {
      const files = new Set();
      const platformRows = runRows.filter((row) => row.platform === platform);
      const jobs = [...groupBy(platformRows, (row) => row.shard + '/' + row.jobId).values()].map((jobRows) => jobRows[0]);
      shards[platform] = validateTopology(runId, platform, jobs);
      for (const row of platformRows) {
        if (files.has(row.file)) throw new Error(runId + ': duplicate ' + platform + ' file ' + row.file);
        files.add(row.file);
      }
    }
    for (const [jobId, jobRows] of groupBy(runRows, (row) => row.jobId)) {
      if (new Set(jobRows.map((row) => row.platform + '/' + row.shard)).size !== 1) {
        throw new Error(runId + ': duplicate job ID ' + jobId + ' across shards or platforms');
      }
      if (jobOwners.has(jobId)) {
        throw new Error(runId + ': duplicate job ID ' + jobId + ' across samples (also in ' + jobOwners.get(jobId) + ')');
      }
      jobOwners.set(jobId, runId);
    }
    sourceCoverage.push({ runId, shards });
  }
  return sourceCoverage.sort((a, b) => a.runId.localeCompare(b.runId, 'en', { numeric: true }));
}

export function calibrateDurations(rows, files, previousTable) {
  const sourceCoverage = validateRuns(rows);
  const table = { sourceRuns: sourceCoverage.map(({ runId }) => runId), seconds: {} };
  const report = {};
  const pendingSplitGroups = {};
  const splitGroups = Object.entries(previousTable?.splitEstimates?.localSecondsByParent ?? {});
  if (!files.length || files.some((file) => !integrationFile.test(file)) || new Set(files).size !== files.length) {
    throw new Error('Expected unique discovered ordinary integration files.');
  }
  for (const [platform, count] of Object.entries(shardCounts)) {
    const platformRows = rows.filter((row) => row.platform === platform);
    const byFile = groupBy(platformRows, (row) => row.file);
    // Establish a multi-run reference for each shared file. Estimating job
    // speed from ratios (not raw totals) avoids flattening genuinely heavy
    // shards. The median limits individual unusually slow tests' influence.
    const references = new Map([...byFile].filter(([, samples]) => samples.length >= 2)
      .map(([file, samples]) => [file, median(samples.map((row) => row.seconds))]));
    const normalized = [];
    const normalizationFactors = [];
    for (const jobRows of groupBy(platformRows, (row) => row.runId + '/' + row.jobId).values()) {
      const ratios = jobRows.filter((row) => references.has(row.file))
        .map((row) => row.seconds / references.get(row.file));
      if (!ratios.length) throw new Error('No overlapping timing samples for job ' + jobRows[0].jobId);
      const factor = median(ratios);
      const { runId, jobId, shard } = jobRows[0];
      normalizationFactors.push({ runId, jobId, shard, factor: Number(factor.toFixed(3)) });
      normalized.push(...jobRows.map((row) => ({ ...row, seconds: row.seconds / factor })));
    }
    const normalizedByFile = groupBy(normalized, (row) => row.file);
    // Keep the whole still-discovered group together until every child has
    // multiple actual observations on this platform. Mixing measured and old
    // relative weights within the group would distort its total placement.
    const pendingFiles = new Set();
    for (const [parent, localSeconds] of splitGroups) {
      const children = Object.keys(localSeconds).filter((file) => files.includes(file));
      if (children.some((file) => (normalizedByFile.get(file)?.length ?? 0) < 2)) {
        pendingSplitGroups[parent] = localSeconds;
        for (const child of children) pendingFiles.add(child);
      }
    }

    const seconds = {};
    const retainedEstimateFiles = [];
    let measuredFiles = 0;
    for (const file of [...files].sort()) {
      if (pendingFiles.has(file)) {
        const previous = previousTable.seconds[platform]?.[file];
        if (Number.isFinite(previous) && previous > 0) {
          seconds[file] = previous;
          retainedEstimateFiles.push(file);
        }
        continue;
      }
      const samples = normalizedByFile.get(file) ?? [];
      // A single observation (or none) isn't a multi-run estimate. Let the
      // existing sequencer use its median fallback and report the gap.
      if (samples.length >= 2) {
        seconds[file] = Math.max(0.001, Number(median(samples.map((row) => row.seconds)).toFixed(3)));
        measuredFiles++;
      }
    }
    if (!Object.keys(seconds).length) throw new Error('No multi-run measurements or retained estimates for discovered ' + platform + ' files.');
    table.seconds[platform] = seconds;
    const specs = files.map((file) => ({ moduleId: path.join(cliRoot, file) }));
    const known = Object.values(seconds).sort((a, b) => a - b);
    const fallback = known[Math.floor(known.length / 2)];
    const shards = partitionByDuration(specs, count, cliRoot, seconds).map((shard) => ({
      files: shard.length,
      seconds: shard.reduce((sum, spec) => sum + (seconds[path.relative(cliRoot, spec.moduleId).replaceAll('\\', '/')] ?? fallback), 0),
    }));
    const totals = shards.map((shard) => shard.seconds);
    report[platform] = {
      measuredFiles,
      retainedEstimateFiles,
      unmeasuredFiles: files.filter((file) => !Object.hasOwn(seconds, file)),
      ignoredFiles: [...byFile.keys()].filter((file) => !files.includes(file)).sort(),
      fallbackSeconds: fallback,
      normalizationFactors,
      shards: shards.map((shard) => ({ ...shard, seconds: Number(shard.seconds.toFixed(3)) })),
      ratio: Number((Math.max(...totals) / Math.min(...totals)).toFixed(3)),
    };
  }
  if (Object.keys(pendingSplitGroups).length) {
    table.splitEstimates = {
      ...previousTable.splitEstimates,
      sourceRuns: previousTable.splitEstimates.sourceRuns ?? previousTable.sourceRuns,
      localSecondsByParent: pendingSplitGroups,
    };
  }
  return { table, report, sourceCoverage };
}

function gh(args) {
  return execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}

function attemptJobs(runId, attempt, headSha, invokeGh) {
  const endpoint = 'repos/{owner}/{repo}/actions/runs/' + runId + '/attempts/' + attempt + '/jobs?per_page=100';
  const pages = JSON.parse(invokeGh(['api', '--method', 'GET', endpoint, '--paginate', '--slurp']));
  const jobs = pages.flatMap((page) => page.jobs);
  if (!jobs.length || jobs.length !== pages[0].total_count
    || new Set(jobs.map((job) => job.id)).size !== jobs.length
    || jobs.some((job) => !positiveId(job.id) || String(job.run_id) !== runId
      || String(job.run_attempt) !== attempt || job.head_sha !== headSha)) {
    throw new Error(runId + '@' + attempt + ': incomplete, reused, or mismatched attempt jobs.');
  }
  return jobs;
}

// Resolve bare remote IDs to a specific attempt before collecting evidence.
// Read the exact attempt endpoints: latest-run job lists can be composites.
export function readCiSampleJobs(key, invokeGh = gh) {
  const identity = sampleIdentity(key);
  if (!identity) throw new Error('Invalid CI sample ID ' + key);
  const [, runId, requestedAttempt] = identity;
  const endpoint = 'repos/{owner}/{repo}/actions/runs/' + runId;
  const attempt = requestedAttempt ?? String(JSON.parse(invokeGh(['api', '--method', 'GET', endpoint])).run_attempt);
  if (!positiveId(attempt)) throw new Error('Invalid attempt for run ' + runId);
  const sampleId = runId + '@' + attempt;
  const run = JSON.parse(invokeGh(['api', '--method', 'GET', endpoint + '/attempts/' + attempt]));
  if (String(run.id) !== runId || String(run.run_attempt) !== attempt || !run.head_sha
    || run.path !== '.github/workflows/ci.yml' || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('Sample ' + sampleId + ' is not a successful ci.yml attempt.');
  }
  const runStartedAt = Date.parse(run.run_started_at);
  if (!Number.isFinite(runStartedAt)) throw new Error(sampleId + ': missing valid attempt start time.');
  const jobs = attemptJobs(runId, attempt, run.head_sha, invokeGh);
  // GitHub may assign copied successful jobs new IDs and the current
  // run_attempt while retaining their original execution timestamps.
  for (const job of jobs) {
    if (job.conclusion === 'skipped') continue;
    const startedAt = Date.parse(job.started_at);
    const completedAt = Date.parse(job.completed_at);
    if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)
      || startedAt < runStartedAt || completedAt < startedAt) {
      throw new Error(sampleId + ': reused or invalid job execution times for ' + job.name);
    }
  }
  // A successful partial rerun can inherit the first attempt's outcome. It
  // must not be counted as an independent full sample, even if all of the
  // timing jobs happen to be among the rerun subset.
  if (attempt !== '1') {
    const initialJobs = attemptJobs(runId, '1', run.head_sha, invokeGh);
    const names = new Set(jobs.map((job) => job.name));
    // A skipped reusable workflow appears as a placeholder. After upstream
    // recovery it can legitimately expand into fresh descendant jobs.
    if (initialJobs.some((job) => !names.has(job.name)
      && !(job.conclusion === 'skipped' && jobs.some((current) => current.name.startsWith(job.name + ' / '))))) {
      throw new Error(sampleId + ': partial rerun; missing initial workflow jobs.');
    }
  }
  const selected = [];
  for (const [platform, prefix] of Object.entries(jobPrefixes)) {
    const base = prefix + ' / Node 24 / integration';
    const candidates = jobs.filter((job) => job.name === base || job.name.startsWith(base + ' '))
      .map((job) => {
        const match = /^ (\d+) of (\d+)$/u.exec(job.name.slice(base.length));
        const shard = match ? match[1] + '/' + match[2] : platform === 'linux' && job.name === base ? '1/1' : null;
        if (!shard || job.status !== 'completed' || job.conclusion !== 'success') {
          throw new Error('Sample ' + sampleId + ': invalid or unsuccessful job ' + job.name);
        }
        return { runId: sampleId, platform, jobId: String(job.id), shard };
      });
    validateTopology(sampleId, platform, candidates);
    selected.push(...candidates);
  }
  return { runId, attempt, jobs: selected };
}

export function readCiRuns(runIds, invokeGh = gh) {
  validateSampleKeys(runIds);
  const samples = runIds.map((key) => readCiSampleJobs(key, invokeGh));
  const selectedIds = samples.flatMap((sample) => sample.jobs.map((job) => job.jobId));
  if (new Set(selectedIds).size !== selectedIds.length) throw new Error('Duplicate job IDs across CI samples.');
  return samples.flatMap(({ runId, attempt, jobs }) => jobs.flatMap((job) =>
    parseIntegrationLog(invokeGh(['run', 'view', runId, '--attempt', attempt, '--job', job.jobId, '--log']), job)));
}

export function readLogDirectory(directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.log')).sort().flatMap((name) => {
    const match = /^([1-9]\d*(?:@[1-9]\d*)?)-(\d+)-(win32|darwin|linux)-(\d+)-of-(\d+)\.log$/u.exec(name);
    if (!match) throw new Error('Expected SAMPLE_ID-JOB_ID-PLATFORM-INDEX-of-COUNT.log: ' + name);
    const [, runId, jobId, platform, index, count] = match;
    return parseIntegrationLog(fs.readFileSync(path.join(directory, name), 'utf8'),
      { runId, jobId, platform, shard: index + '/' + count });
  });
}

function discoverIntegrationFiles() {
  const output = execFileSync(process.execPath, [
    path.join(repoRoot, 'scripts/test/run-vitest.mjs'), 'list', '--project', 'integration',
    'tests/integration', '--config', 'vitest.integration-shard.config.ts', '--json',
  ], { cwd: cliRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  return [...new Set(JSON.parse(output).map((entry) => path.relative(cliRoot, entry.file).replaceAll('\\', '/')))].sort();
}

function main() {
  const { values } = parseArgs({ options: {
    run: { type: 'string', multiple: true }, 'log-dir': { type: 'string' }, tsv: { type: 'string' },
    'timings-out': { type: 'string' }, write: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node packages/cli/scripts/refresh-integration-durations.mjs\n'
      + '  (--run SAMPLE_ID --run SAMPLE_ID --run SAMPLE_ID [--run ...] | --log-dir DIR | --tsv FILE)\n'
      + '  [--timings-out FILE] [--write]\n'
      + 'Supply 3–5 independent successful full CI attempts. SAMPLE_ID is RUN_ID@ATTEMPT,\n'
      + 'or a bare RUN_ID (latest attempt for remote --run; legacy ID for local inputs).\n'
      + 'Do not mix a bare ID with explicit attempts of the same run, or reuse job IDs.\n'
      + 'Local logs must be complete successful job logs, named SAMPLE_ID-JOB_ID-PLATFORM-INDEX-of-COUNT.log;\n'
      + 'TSV keeps its original run_id column, containing the sample ID.\n'
      + 'Each run must include Windows (3, 4 or 6 shards), macOS (2), and Linux Node 24 (1 or 2).\n'
      + 'Without --write, print estimates without replacing integration-durations.json.');
    return;
  }
  if ([values.run, values['log-dir'], values.tsv].filter(Boolean).length !== 1) {
    throw new Error('Choose exactly one timing source: --run, --log-dir or --tsv (see --help).');
  }
  const rows = values.run ? readCiRuns(values.run) : values['log-dir'] ? readLogDirectory(values['log-dir'])
    : parseTimingsTsv(fs.readFileSync(values.tsv, 'utf8'));
  validateRuns(rows);
  if (values['timings-out']) fs.writeFileSync(values['timings-out'], formatTimingsTsv(rows));
  const tableUrl = new URL('./integration-durations.json', import.meta.url);
  const previousTable = JSON.parse(fs.readFileSync(tableUrl, 'utf8'));
  const { table, report, sourceCoverage } = calibrateDurations(rows, discoverIntegrationFiles(), previousTable);
  console.log(JSON.stringify({
    sourceRuns: table.sourceRuns,
    sourceCoverage,
    splitEstimateSourceRuns: table.splitEstimates?.sourceRuns,
    units: 'normalized file seconds, not job wall-clock',
    ...report,
  }, null, 2));
  if (values.write) {
    fs.writeFileSync(tableUrl, JSON.stringify(table, null, 2) + '\n');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
