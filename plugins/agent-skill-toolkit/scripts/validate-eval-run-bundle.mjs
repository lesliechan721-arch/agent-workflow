#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return 'Usage: validate-eval-run-bundle.mjs <bundle.json> [--format text|json]';
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let format = 'text';
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--format') format = argv[++index];
    else if (value.startsWith('-')) throw new Error(`Unknown option: ${value}`);
    else positional.push(path.resolve(value));
  }
  if (positional.length !== 1) throw new Error(usage());
  if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json.');
  return { bundlePath: positional[0], format };
}

async function firstReadable(candidates) {
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Try the next canonical or distributed copy.
    }
  }
  throw new Error('Cannot locate EvalRunBundle schema.');
}

async function schemaErrors(bundlePath) {
  const schemaPath = await firstReadable([
    path.join(scriptRoot, '..', 'schemas', 'eval-run-bundle.schema.json'),
    path.join(scriptRoot, '..', 'assets', 'eval-run-bundle.schema.json'),
  ]);
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(scriptRoot, 'validate-json-contract.mjs'),
        schemaPath,
        bundlePath,
        '--format',
        'json',
      ],
      { encoding: 'utf8' },
    );
    return JSON.parse(stdout).errors;
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim())
      return JSON.parse(error.stdout).errors;
    throw error;
  }
}

function identity(values) {
  return JSON.stringify(values);
}

function graderIdentity(run) {
  const grader = run.grading?.grader;
  return grader ? identity([grader.id, grader.version]) : null;
}

export function comparisonAggregate(runs) {
  const groups = new Map();
  for (const run of runs) {
    if (run.comparisonId === null) continue;
    const key = identity([run.comparisonId, run.caseId, run.runIndex]);
    if (!groups.has(key))
      groups.set(key, {
        comparisonId: run.comparisonId,
        caseId: run.caseId,
        runIndex: run.runIndex,
        runs: [],
      });
    groups.get(key).runs.push(run);
  }
  return [...groups.values()]
    .map((group) => {
      const withSkill = group.runs.filter(
        (run) => run.skillMode === 'with-skill' && run.status === 'completed',
      );
      const baselines = group.runs.filter(
        (run) => run.skillMode !== 'with-skill' && run.status === 'completed',
      );
      const paired = withSkill.length > 0 && baselines.length > 0;
      const comparable =
        paired &&
        withSkill.some((current) => {
          const currentGrader = graderIdentity(current);
          return (
            currentGrader !== null &&
            baselines.some((baseline) => graderIdentity(baseline) === currentGrader)
          );
        });
      return {
        comparisonId: group.comparisonId,
        caseId: group.caseId,
        runIndex: group.runIndex,
        paired,
        comparable,
      };
    })
    .sort((left, right) =>
      identity([left.comparisonId, left.caseId, left.runIndex]).localeCompare(
        identity([right.comparisonId, right.caseId, right.runIndex]),
      ),
    );
}

function sameAggregate(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function isCanonicalEvidencePath(value) {
  if (
    value.length === 0 ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  )
    return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

async function evidenceErrors(evidenceRoot, value, expectedDigest, label) {
  if (!isCanonicalEvidencePath(value))
    return [`${label} must be a canonical POSIX relative file path`];
  const candidate = path.resolve(evidenceRoot, value);
  if (!isPathInside(evidenceRoot, candidate)) return [`${label} leaves the evidence root`];
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) return [`${label} must not be a symlink`];
    if (!info.isFile()) return [`${label} must be a regular file`];
    const actual = await realpath(candidate);
    if (!isPathInside(evidenceRoot, actual)) return [`${label} leaves the evidence root`];
    const actualDigest = `sha256:${createHash('sha256')
      .update(await readFile(actual))
      .digest('hex')}`;
    return actualDigest === expectedDigest ? [] : [`${label} digest does not match file content`];
  } catch {
    return [`${label} does not resolve to a regular evidence file`];
  }
}

export async function validateEvalRunBundle(bundlePath, options = {}) {
  const errors = await schemaErrors(bundlePath);
  if (errors.length > 0) return { valid: false, errors, calculated: null };

  const bundleBytes = await readFile(bundlePath);
  const bundle = JSON.parse(bundleBytes.toString('utf8'));
  const evidenceRoot = await realpath(options.evidenceRoot ?? path.dirname(bundlePath));
  const runIdentities = new Set();
  for (let runIndex = 0; runIndex < bundle.runs.length; runIndex += 1) {
    const run = bundle.runs[runIndex];
    const key = identity([run.caseId, run.configuration, run.runIndex]);
    if (runIdentities.has(key)) errors.push(`duplicate run identity ${key}`);
    runIdentities.add(key);
    if (run.skillMode === 'with-skill' && run.skillDigest !== bundle.targetSkillDigest)
      errors.push(`with-skill run ${key} must use targetSkillDigest`);
    if (run.skillMode === 'without-skill' && run.skillDigest !== null)
      errors.push(`without-skill run ${key} must use skillDigest=null`);
    if (run.skillMode === 'previous-version' && run.skillDigest === null)
      errors.push(`previous-version run ${key} must use a Skill digest`);
    errors.push(
      ...(await evidenceErrors(
        evidenceRoot,
        run.stdoutPath,
        run.stdoutDigest,
        `runs[${runIndex}].stdoutPath`,
      )),
      ...(await evidenceErrors(
        evidenceRoot,
        run.stderrPath,
        run.stderrDigest,
        `runs[${runIndex}].stderrPath`,
      )),
    );
    for (let artifactIndex = 0; artifactIndex < run.artifacts.length; artifactIndex += 1) {
      const artifact = run.artifacts[artifactIndex];
      errors.push(
        ...(await evidenceErrors(
          evidenceRoot,
          artifact.path,
          artifact.digest,
          `runs[${runIndex}].artifacts[${artifactIndex}].path`,
        )),
      );
    }
  }

  const comparisons = comparisonAggregate(bundle.runs);
  const calculated = {
    bundleDigest: `sha256:${createHash('sha256').update(bundleBytes).digest('hex')}`,
    cases: new Set(bundle.runs.map((run) => run.caseId)).size,
    configurations: new Set(bundle.runs.map((run) => run.configuration)).size,
    runs: bundle.runs.length,
    completed: bundle.runs.filter((run) => run.status === 'completed').length,
    processFailed: bundle.runs.filter(
      (run) => run.status === 'process-failed' || run.status === 'error',
    ).length,
    timedOut: bundle.runs.filter((run) => run.status === 'timeout').length,
    comparisons,
  };
  for (const name of [
    'cases',
    'configurations',
    'runs',
    'completed',
    'processFailed',
    'timedOut',
  ]) {
    if (bundle.aggregate[name] !== calculated[name])
      errors.push(`aggregate.${name} does not match runs`);
  }
  const actualComparisons = [...bundle.aggregate.comparisons].sort((left, right) =>
    identity([left.comparisonId, left.caseId, left.runIndex]).localeCompare(
      identity([right.comparisonId, right.caseId, right.runIndex]),
    ),
  );
  if (!sameAggregate(actualComparisons, comparisons))
    errors.push('aggregate.comparisons does not match runs');

  const comparisonPlanned = comparisons.length > 0;
  if (bundle.comparisonPlanned !== comparisonPlanned)
    errors.push('comparisonPlanned does not match run comparison identities');
  const hasComparableEvidence = comparisons.some((entry) => entry.comparable);
  const expectedEvidenceLevel = hasComparableEvidence ? 'comparative' : 'executed';
  if (bundle.evidenceLevel !== expectedEvidenceLevel)
    errors.push(`evidenceLevel must be ${expectedEvidenceLevel} for the supplied runs`);
  if (comparisons.some((entry) => !entry.comparable) && bundle.limitations.length === 0)
    errors.push('non-comparable planned comparisons require a limitation');

  return { valid: errors.length === 0, errors, calculated };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await validateEvalRunBundle(options.bundlePath);
  process.stdout.write(
    options.format === 'json'
      ? `${JSON.stringify(result, null, 2)}\n`
      : result.valid
        ? 'EvalRunBundle is valid.\n'
        : `${result.errors.join('\n')}\n`,
  );
  if (!result.valid) process.exitCode = 1;
}

const invokedPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => path.resolve(process.argv[1]))
  : null;
const modulePath = await realpath(fileURLToPath(import.meta.url)).catch(() =>
  path.resolve(fileURLToPath(import.meta.url)),
);
if (invokedPath === modulePath) {
  main().catch((error) => {
    process.stderr.write(`[ERROR] ${error.message}\n`);
    process.exit(1);
  });
}
