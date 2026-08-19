#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const IGNORED_NAMES = new Set(['.DS_Store', '.git', 'node_modules']);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const STAGE_CONTRACTS = new Map([
  ['reference-audit', {
    producer: 'review-agent-content',
    schema: 'ReferenceAuditResult',
    resultKind: 'reference-audit',
  }],
  ['source-skill-review', {
    producer: 'review-agent-skill',
    schema: 'ReviewResult',
    resultKind: 'source-review',
  }],
  ['materialized-profile-review', {
    producer: 'review-agent-skill',
    schema: 'ReviewResult',
    resultKind: 'materialized-review',
  }],
]);
const EVAL_STAGE_CONTRACTS = new Map([
  ['eval-audit', { mode: 'preflight' }],
  ['eval-result-triage', { mode: 'result-triage' }],
]);

function usage() {
  return [
    'Usage:',
    '  node validate-review-stage-result.mjs <stage-envelope.json> [options]',
    '  node validate-review-stage-result.mjs --verify-bundle <review-input-bundle.json> [options]',
    '  node validate-review-stage-result.mjs --digest-only <target> [options]',
    '',
    'Options:',
    '  --repo-root <path>  Workspace boundary and base for relative paths. Default: current directory.',
    '  --format <format>    text or json. Default: text.',
    '  -h, --help           Show this help.',
  ].join('\n');
}

function fail(message) {
  throw new Error(message);
}

function optionValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${flag} requires a value.`);
  return value;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const options = {
    mode: 'envelope',
    input: null,
    repoRoot: process.cwd(),
    format: 'text',
  };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--repo-root') {
      options.repoRoot = path.resolve(optionValue(args, index, value));
      index += 1;
    } else if (value === '--format') {
      options.format = optionValue(args, index, value);
      index += 1;
    } else if (value === '--verify-bundle') {
      if (options.mode !== 'envelope' || options.input !== null) fail('Choose exactly one validation mode.');
      options.mode = 'bundle';
      options.input = path.resolve(optionValue(args, index, value));
      index += 1;
    } else if (value === '--digest-only') {
      if (options.mode !== 'envelope' || options.input !== null) fail('Choose exactly one validation mode.');
      options.mode = 'digest';
      options.input = path.resolve(optionValue(args, index, value));
      index += 1;
    } else if (value.startsWith('-')) {
      fail(`Unknown option: ${value}`);
    } else {
      positional.push(value);
    }
  }
  if (!['text', 'json'].includes(options.format)) fail('--format must be text or json.');
  if (options.mode === 'envelope') {
    if (options.input !== null || positional.length !== 1) fail(usage());
    options.input = path.resolve(positional[0]);
  } else if (positional.length > 0) {
    fail('Do not combine a positional envelope with --verify-bundle or --digest-only.');
  }
  return options;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string.`);
  return value;
}

function requireOnlyKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (extra.length > 0) fail(`${label} has unsupported fields: ${extra.join(', ')}.`);
}

function sha256(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function canonicalRepoRoot(repoRoot) {
  const resolved = path.resolve(repoRoot);
  const stat = await lstat(resolved).catch(() => null);
  if (!stat?.isDirectory()) fail(`--repo-root is not a directory: ${resolved}`);
  return realpath(resolved);
}

async function resolveInside(repoRoot, candidate, label) {
  const resolved = path.resolve(candidate);
  const canonical = await realpath(resolved).catch(() => null);
  if (!canonical) fail(`${label} does not exist: ${resolved}`);
  if (!isInside(repoRoot, canonical)) fail(`${label} must stay inside --repo-root.`);
  return canonical;
}

function portableRelative(repoRoot, candidate, options = {}) {
  const relative = path.relative(repoRoot, candidate);
  if (relative === '' && options.allowRoot === true) return '.';
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('Validated artifact path must be below --repo-root.');
  }
  return relative.split(path.sep).join('/');
}

async function collectDigestEntries(targetRoot) {
  const rootStat = await lstat(targetRoot);
  if (rootStat.isSymbolicLink()) fail(`Target contains a symbolic link: ${targetRoot}`);
  if (rootStat.isFile()) {
    return [{ absolutePath: targetRoot, relativePath: path.basename(targetRoot), kind: 'file' }];
  }
  if (!rootStat.isDirectory()) fail(`Target must be a file or directory: ${targetRoot}`);
  const files = [];
  async function walk(directory, relativeDirectory = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name).split(path.sep).join('/');
      if (entry.isSymbolicLink()) fail(`Target contains a symbolic link: ${absolutePath}`);
      if (entry.isDirectory()) await walk(absolutePath, relativePath);
      else if (entry.isFile()) files.push({ absolutePath, relativePath, kind: 'file' });
      else fail(`Target contains an unsupported filesystem entry: ${absolutePath}`);
    }
  }
  await walk(targetRoot);
  return files;
}

async function digestPath(targetRoot) {
  const entries = await collectDigestEntries(targetRoot);
  const hash = createHash('sha256');
  hash.update('review-target-v1\0');
  for (const entry of entries) {
    hash.update(entry.kind);
    hash.update('\0');
    hash.update(entry.relativePath);
    hash.update('\0');
    hash.update(await readFile(entry.absolutePath));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${filePath}: ${error.message}`);
  }
}

async function firstReadable(candidates, label) {
  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // Try the next canonical or copied location.
    }
  }
  fail(`Cannot locate ${label}.`);
}

async function runValidator(scriptPath, args, label) {
  try {
    return await execFileAsync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error?.stdout || error?.stderr || error?.message || error).trim();
    fail(`${label} failed${detail ? `: ${detail}` : '.'}`);
  }
}

async function validateResultObject(contract, result) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'review-stage-result-'));
  const valuePath = path.join(temporaryRoot, 'result.json');
  try {
    await writeFile(valuePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    if (contract.schema === 'ReviewResult') {
      const validator = await firstReadable([
        path.join(scriptRoot, 'validate-review-result.mjs'),
      ], 'ReviewResult validator');
      await runValidator(validator, [valuePath, '--format', 'json'], 'ReviewResult validation');
    } else if (contract.schema === 'ReferenceAuditResult') {
      const validator = await firstReadable([
        path.join(scriptRoot, 'validate-json-contract.mjs'),
      ], 'JSON contract validator');
      const schema = await firstReadable([
        path.join(scriptRoot, '..', 'schemas', 'reference-audit-result.schema.json'),
        path.join(scriptRoot, '..', 'assets', 'reference-audit-result.schema.json'),
      ], 'ReferenceAuditResult schema');
      await runValidator(validator, [schema, valuePath, '--format', 'json'], 'ReferenceAuditResult validation');
    } else {
      fail(`Unsupported stage result schema: ${contract.schema}`);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function validateReviewResultBinding(stageId, result, targetDigest) {
  const target = requireRecord(result.target, 'result.target');
  if (target.digest !== targetDigest) {
    fail(`result.target.digest must match the validated target digest for ${stageId}.`);
  }
  if (stageId === 'materialized-profile-review' && target.kind !== 'materialized-skill') {
    fail('materialized-profile-review requires result.target.kind=materialized-skill.');
  }
  if (stageId === 'source-skill-review' && !['agent-skill', 'repo-skill', 'aw-plugin-skill'].includes(target.kind)) {
    fail('source-skill-review requires a source Skill target kind.');
  }
}

async function validateEnvelope(envelopePath, repoRoot) {
  const canonicalEnvelope = await resolveInside(repoRoot, envelopePath, 'Stage envelope');
  const raw = await readFile(canonicalEnvelope);
  const envelope = requireRecord(JSON.parse(raw.toString('utf8')), 'Stage envelope');
  requireOnlyKeys(
    envelope,
    ['schemaVersion', 'stageId', 'producer', 'independentContext', 'target', 'resultSchema', 'result'],
    'Stage envelope',
  );
  if (envelope.schemaVersion !== 1) fail('Stage envelope schemaVersion must be 1.');
  const stageId = requireString(envelope.stageId, 'stageId');
  const contract = STAGE_CONTRACTS.get(stageId);
  if (!contract) fail(`Unsupported envelope stageId: ${stageId}.`);
  if (envelope.producer !== contract.producer) fail(`${stageId} producer must be ${contract.producer}.`);
  if (envelope.independentContext !== true) fail('A reusable stage must declare independentContext=true.');
  if (envelope.resultSchema !== contract.schema) fail(`${stageId} resultSchema must be ${contract.schema}.`);
  const target = requireRecord(envelope.target, 'target');
  requireOnlyKeys(target, ['path', 'digest'], 'target');
  const targetPathValue = requireString(target.path, 'target.path');
  if (!DIGEST_PATTERN.test(requireString(target.digest, 'target.digest'))) fail('target.digest must be sha256:<64 lowercase hex>.');
  const canonicalTarget = await resolveInside(repoRoot, path.resolve(repoRoot, targetPathValue), 'Stage target');
  const targetDigest = await digestPath(canonicalTarget);
  if (target.digest !== targetDigest) fail('target.digest does not match the current target contents.');
  const result = requireRecord(envelope.result, 'result');
  await validateResultObject(contract, result);
  if (contract.schema === 'ReviewResult') validateReviewResultBinding(stageId, result, targetDigest);
  return {
    id: stageId,
    producer: contract.producer,
    independentContext: true,
    targetDigest,
    resultPath: portableRelative(repoRoot, canonicalEnvelope),
    resultDigest: sha256(raw),
    schema: contract.schema,
  };
}

async function validateEvalStage(stage, repoRoot) {
  const contract = EVAL_STAGE_CONTRACTS.get(stage.id);
  if (!contract) fail(`Unsupported direct stage type: ${stage.id}.`);
  if (stage.producer !== 'audit-agent-skill-evals') fail(`${stage.id} producer must be audit-agent-skill-evals.`);
  if (stage.schema !== 'EvalAuditResult') fail(`${stage.id} schema must be EvalAuditResult.`);
  if (stage.independentContext !== true) fail(`${stage.id} must declare independentContext=true.`);
  const resultPath = await resolveInside(repoRoot, path.resolve(repoRoot, stage.resultPath), `${stage.id} result`);
  const raw = await readFile(resultPath);
  if (sha256(raw) !== stage.resultDigest) fail(`${stage.id} resultDigest does not match resultPath.`);
  const result = await readJson(resultPath, `${stage.id} result`);
  if (result.producer !== 'audit-agent-skill-evals' || result.independentContext !== true) {
    fail(`${stage.id} result does not carry the required producer and independent-context evidence.`);
  }
  if (result.mode !== contract.mode) fail(`${stage.id} requires EvalAuditResult.mode=${contract.mode}.`);
  if (result.corpusDigest !== stage.targetDigest) fail(`${stage.id} targetDigest must equal EvalAuditResult.corpusDigest.`);
  const validator = await firstReadable([
    path.join(scriptRoot, 'validate-eval-audit-result.mjs'),
  ], 'EvalAuditResult validator');
  await runValidator(validator, [resultPath, '--format', 'json'], `${stage.id} validation`);
  return {
    id: stage.id,
    producer: 'audit-agent-skill-evals',
    independentContext: true,
    targetDigest: result.corpusDigest,
    resultPath: portableRelative(repoRoot, resultPath),
    resultDigest: sha256(raw),
    schema: 'EvalAuditResult',
  };
}

function compareStageRecord(actual, expected) {
  for (const key of ['id', 'producer', 'independentContext', 'targetDigest', 'resultPath', 'resultDigest', 'schema']) {
    if (actual[key] !== expected[key]) fail(`providedStages record differs from validated result at ${key}.`);
  }
}

async function validateBundle(bundlePath, repoRoot) {
  const canonicalBundle = await resolveInside(repoRoot, bundlePath, 'ReviewInputBundle');
  const jsonValidator = await firstReadable([
    path.join(scriptRoot, 'validate-json-contract.mjs'),
  ], 'JSON contract validator');
  const schemaPath = await firstReadable([
    path.join(scriptRoot, '..', 'schemas', 'review-input-bundle.schema.json'),
    path.join(scriptRoot, '..', 'assets', 'review-input-bundle.schema.json'),
  ], 'ReviewInputBundle schema');
  await runValidator(jsonValidator, [schemaPath, canonicalBundle, '--format', 'json'], 'ReviewInputBundle schema validation');
  const bundle = await readJson(canonicalBundle, 'ReviewInputBundle');
  const validatedStages = [];
  const seen = new Set();
  for (const stage of bundle.orchestration.providedStages) {
    const key = `${stage.id}\0${stage.targetDigest}`;
    if (seen.has(key)) fail(`Duplicate provided stage for ${stage.id} and ${stage.targetDigest}.`);
    seen.add(key);
    const expected = STAGE_CONTRACTS.has(stage.id)
      ? await validateEnvelope(path.resolve(repoRoot, stage.resultPath), repoRoot)
      : await validateEvalStage(stage, repoRoot);
    compareStageRecord(stage, expected);
    validatedStages.push(expected);
  }
  return {
    valid: true,
    bundlePath: portableRelative(repoRoot, canonicalBundle),
    stageCount: validatedStages.length,
    stages: validatedStages,
  };
}

function writeOutput(options, output) {
  if (options.format === 'json') {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }
  if (options.mode === 'digest') process.stdout.write(`${output.digest}\n`);
  else if (options.mode === 'envelope') process.stdout.write(`${JSON.stringify(output.stage)}\n`);
  else process.stdout.write(`ReviewInputBundle stage handoffs are valid (${output.stageCount}).\n`);
}

async function main() {
  const options = parseArgs(process.argv);
  const repoRoot = await canonicalRepoRoot(options.repoRoot);
  if (options.mode === 'digest') {
    const target = await resolveInside(repoRoot, options.input, 'Digest target');
    writeOutput(options, {
      valid: true,
      target: portableRelative(repoRoot, target, { allowRoot: true }),
      digest: await digestPath(target),
    });
    return;
  }
  if (options.mode === 'bundle') {
    writeOutput(options, await validateBundle(options.input, repoRoot));
    return;
  }
  writeOutput(options, { valid: true, stage: await validateEnvelope(options.input, repoRoot) });
}

main().catch((error) => {
  process.stderr.write(`[ERROR] ${error.message}\n`);
  process.exit(1);
});
