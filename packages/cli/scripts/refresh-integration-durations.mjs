import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';

import { partitionByDuration } from './integration-sequencer.mjs';

const cliRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = path.resolve(cliRoot, '../..');
const shardCounts = { win32: 3, darwin: 2 };
const timingHeader = 'run_id\tjob_id\tplatform\tshard\tfile\tseconds';
const integrationFile = /^tests\/integration\/.+\.test\.tsx?$/u;

function positiveId(id) {
  return /^[1-9]\d*$/u.test(id);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validateRow(row) {
  const { runId, jobId, platform, shard, file, seconds } = row;
  const count = shardCounts[platform];
  if (!positiveId(runId) || !positiveId(jobId) || !Object.hasOwn(shardCounts, platform)
    || !Array.from({ length: count }, (_, index) => (index + 1) + '/' + count).includes(shard)
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
      // The integration step ends here. Shard 3/2 subsequently runs separate
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

function validateRuns(rows) {
  for (const row of rows) validateRow(row);
  const runs = groupBy(rows, (row) => row.runId);
  if (runs.size < 3 || runs.size > 5) throw new Error('Provide 3–5 distinct successful CI runs.');
  for (const [runId, runRows] of runs) {
    for (const [platform, count] of Object.entries(shardCounts)) {
      const files = new Set();
      const platformRows = runRows.filter((row) => row.platform === platform);
      for (let index = 1; index <= count; index++) {
        const shard = index + '/' + count;
        const jobRows = platformRows.filter((row) => row.shard === shard);
        if (!jobRows.length) throw new Error(runId + ': missing ' + platform + ' ' + shard);
        if (new Set(jobRows.map((row) => row.jobId)).size !== 1) {
          throw new Error(runId + ': multiple jobs for ' + platform + ' ' + shard);
        }
        for (const row of jobRows) {
          if (files.has(row.file)) throw new Error(runId + ': duplicate ' + platform + ' file ' + row.file);
          files.add(row.file);
        }
      }
    }
  }
  return [...runs.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

export function calibrateDurations(rows, files) {
  const sourceRuns = validateRuns(rows);
  const table = { sourceRuns, seconds: {} };
  const report = {};
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
    const seconds = {};
    for (const file of [...files].sort()) {
      const samples = normalizedByFile.get(file) ?? [];
      // A single observation (or none) isn't a multi-run estimate. Let the
      // existing sequencer use its median fallback and report the gap.
      if (samples.length >= 2) seconds[file] = Math.max(0.001, Number(median(samples.map((row) => row.seconds)).toFixed(3)));
    }
    if (!Object.keys(seconds).length) throw new Error('No multi-run measurements for discovered ' + platform + ' files.');
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
      measuredFiles: Object.keys(seconds).length,
      unmeasuredFiles: files.filter((file) => !Object.hasOwn(seconds, file)),
      ignoredFiles: [...byFile.keys()].filter((file) => !files.includes(file)).sort(),
      fallbackSeconds: fallback,
      normalizationFactors,
      shards: shards.map((shard) => ({ ...shard, seconds: Number(shard.seconds.toFixed(3)) })),
      ratio: Number((Math.max(...totals) / Math.min(...totals)).toFixed(3)),
    };
  }
  return { table, report };
}

function gh(args) {
  return execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
}

function readCiRuns(runIds) {
  if (runIds.some((id) => !positiveId(id)) || new Set(runIds).size !== runIds.length) {
    throw new Error('Run IDs must be distinct positive decimal IDs.');
  }
  const rows = [];
  for (const runId of runIds) {
    const run = JSON.parse(gh(['api', '--method', 'GET', 'repos/{owner}/{repo}/actions/runs/' + runId]));
    if (run.path !== '.github/workflows/ci.yml' || run.conclusion !== 'success') {
      throw new Error('Run ' + runId + ' is not a successful ci.yml run.');
    }
    const { jobs } = JSON.parse(gh(['run', 'view', runId, '--attempt', String(run.run_attempt), '--json', 'jobs']));
    for (const [platform, count] of Object.entries(shardCounts)) {
      for (let index = 1; index <= count; index++) {
        const name = (platform === 'win32' ? 'win32 x64' : 'darwin arm64') + ' / Node 24 / integration ' + index + ' of ' + count;
        const matches = jobs.filter((job) => job.name === name);
        if (matches.length !== 1 || matches[0].conclusion !== 'success') {
          throw new Error('Run ' + runId + ': missing successful job ' + name);
        }
        const jobId = String(matches[0].databaseId);
        const log = gh(['run', 'view', runId, '--job', jobId, '--log']);
        rows.push(...parseIntegrationLog(log, { runId, jobId, platform, shard: index + '/' + count }));
      }
    }
  }
  return rows;
}

function readLogDirectory(directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.log')).sort().flatMap((name) => {
    const match = /^(\d+)-(\d+)-(win32|darwin)-(\d+)-of-(\d+)\.log$/u.exec(name);
    if (!match) throw new Error('Expected RUN_ID-JOB_ID-PLATFORM-INDEX-of-COUNT.log: ' + name);
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
      + '  (--run RUN_ID --run RUN_ID --run RUN_ID [--run ...] | --log-dir DIR | --tsv FILE)\n'
      + '  [--timings-out FILE] [--write]\n'
      + 'Supply 3–5 successful CI runs. Local logs must be complete successful job logs,\n'
      + 'named RUN_ID-JOB_ID-PLATFORM-INDEX-of-COUNT.log; TSV uses the extracted timing header.\n'
      + 'Without --write, print estimates without replacing integration-durations.json.');
    return;
  }
  if ([values.run, values['log-dir'], values.tsv].filter(Boolean).length !== 1) {
    throw new Error('Choose exactly one timing source: --run, --log-dir or --tsv (see --help).');
  }
  if (values.run && (values.run.length < 3 || values.run.length > 5)) throw new Error('Provide 3–5 distinct successful CI runs.');
  const rows = values.run ? readCiRuns(values.run) : values['log-dir'] ? readLogDirectory(values['log-dir'])
    : parseTimingsTsv(fs.readFileSync(values.tsv, 'utf8'));
  validateRuns(rows);
  if (values['timings-out']) fs.writeFileSync(values['timings-out'], formatTimingsTsv(rows));
  const { table, report } = calibrateDurations(rows, discoverIntegrationFiles());
  console.log(JSON.stringify({ sourceRuns: table.sourceRuns, units: 'normalized file seconds, not job wall-clock', ...report }, null, 2));
  if (values.write) {
    fs.writeFileSync(new URL('./integration-durations.json', import.meta.url), JSON.stringify(table, null, 2) + '\n');
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
