#!/usr/bin/env node

import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const REVIEW_MODES = new Set(['quick', 'full', 'delta']);
const DESIGNS = new Set(['pass', 'needs-fixes', 'redesign', 'fail', 'not-assessed']);
const COMPLEXITIES = new Set(['proportionate', 'over-specified', 'over-engineered', 'not-assessed']);
const SEVERITIES = new Set(['critical', 'major', 'minor', 'advisory']);
const EVIDENCE_TYPES = new Set([
  'observed',
  'normative',
  'structural',
  'official-guidance',
  'heuristic',
  'inferred',
]);
const STRONG_EVIDENCE_TYPES = new Set(['observed', 'normative', 'structural']);
const OWNERS = new Set(['skill', 'schema', 'client', 'runtime', 'script', 'role', 'eval', 'project', 'user']);
const DIMENSION_CONFIDENCE = new Set(['high', 'medium', 'low', 'unknown']);
const CONFIDENCE_FACTOR = { high: 1, medium: 0.7, low: 0.4, unknown: 0 };
const ROOT_FIELDS = new Set([
  'schemaVersion', 'target', 'mode', 'design', 'complexity', 'summary',
  'findings', 'unknowns', 'evalEvidence', 'dimensions',
]);
const TARGET_FIELDS = new Set(['name', 'digest']);
const FINDING_FIELDS = new Set([
  'severity', 'area', 'evidenceType', 'evidence', 'issue', 'affectedScenario',
  'owner', 'action', 'validation',
]);
const DIMENSION_FIELDS = new Set(['id', 'score', 'confidence', 'basis']);

function usage() {
  return 'Usage: validate-review-result-lite.mjs <review.json> --check <skill-check.json> [--format json|text]';
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const positional = [];
  let check = null;
  let format = 'json';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--check') {
      if (!argv[index + 1] || argv[index + 1].startsWith('-')) throw new Error('--check requires a value.');
      check = path.resolve(argv[++index]);
    } else if (value === '--format') {
      if (!argv[index + 1] || argv[index + 1].startsWith('-')) throw new Error('--format requires a value.');
      format = argv[++index];
    } else if (value.startsWith('-')) throw new Error(`Unknown option: ${value}`);
    else positional.push(path.resolve(value));
  }
  if (positional.length !== 1 || !check) throw new Error(usage());
  if (!['json', 'text'].includes(format)) throw new Error('--format must be json or text.');
  return { review: positional[0], check, format };
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(value, allowed, prefix, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${prefix}.${key} is not allowed`);
  }
}

async function firstReadable(paths) {
  for (const candidate of paths) {
    try {
      return JSON.parse(await readFile(candidate, 'utf8'));
    } catch {}
  }
  throw new Error('Cannot locate canonical review dimensions.');
}

async function loadDimensions() {
  const source = await firstReadable([
    path.join(scriptRoot, '..', 'standards', 'review-dimensions.json'),
    path.join(scriptRoot, '..', 'assets', 'review-dimensions.json'),
  ]);
  if (
    source?.schemaVersion !== 1
    || !Array.isArray(source.dimensions)
    || source.dimensions.length !== 12
    || source.dimensions.reduce((sum, entry) => sum + entry.weight, 0) !== 100
  ) {
    throw new Error('Canonical review dimensions are malformed.');
  }
  return source.dimensions;
}

function validateFinding(finding, index, errors) {
  const prefix = `findings[${index}]`;
  if (!isRecord(finding)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  rejectUnknownFields(finding, FINDING_FIELDS, prefix, errors);
  if (!SEVERITIES.has(finding.severity)) errors.push(`${prefix}.severity is invalid`);
  if (!nonEmpty(finding.area)) errors.push(`${prefix}.area is required`);
  if (!EVIDENCE_TYPES.has(finding.evidenceType)) errors.push(`${prefix}.evidenceType is invalid`);
  if (
    !Array.isArray(finding.evidence)
    || finding.evidence.length === 0
    || finding.evidence.some((entry) => !nonEmpty(entry))
  ) {
    errors.push(`${prefix}.evidence must contain source locations`);
  }
  if (!nonEmpty(finding.issue)) errors.push(`${prefix}.issue is required`);
  if (!nonEmpty(finding.action)) errors.push(`${prefix}.action is required`);
  if (finding.severity === 'critical' || finding.severity === 'major') {
    if (!STRONG_EVIDENCE_TYPES.has(finding.evidenceType)) {
      errors.push(`${prefix} high severity requires observed, normative, or structural evidence`);
    }
    if (!nonEmpty(finding.affectedScenario)) errors.push(`${prefix}.affectedScenario is required`);
    if (finding.owner === undefined) errors.push(`${prefix}.owner is required`);
    if (!nonEmpty(finding.validation)) errors.push(`${prefix}.validation is required`);
  }
  if (finding.owner !== undefined && !OWNERS.has(finding.owner)) {
    errors.push(`${prefix}.owner is invalid`);
  }
}

function validateDimensions(review, dimensions, errors) {
  if (!Array.isArray(review.dimensions)) {
    errors.push('dimensions must be an array');
    return null;
  }
  if (review.mode !== 'full') {
    if (review.dimensions.length !== 0) errors.push('quick and delta reviews must use an empty dimensions array');
    return null;
  }
  if (review.dimensions.length !== dimensions.length) {
    errors.push(`full review must contain exactly ${dimensions.length} dimensions`);
    return null;
  }

  let assessedWeight = 0;
  let weightedPoints = 0;
  let confidencePoints = 0;
  for (const [index, canonical] of dimensions.entries()) {
    const entry = review.dimensions[index];
    const prefix = `dimensions[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    rejectUnknownFields(entry, DIMENSION_FIELDS, prefix, errors);
    if (entry.id !== canonical.id) errors.push(`${prefix}.id must be ${canonical.id}`);
    if (!nonEmpty(entry.basis)) errors.push(`${prefix}.basis is required`);
    if (!DIMENSION_CONFIDENCE.has(entry.confidence)) errors.push(`${prefix}.confidence is invalid`);
    if (entry.score === null) {
      if (entry.confidence !== 'unknown') errors.push(`${prefix} score=null requires confidence=unknown`);
      continue;
    }
    if (
      typeof entry.score !== 'number'
      || !Number.isFinite(entry.score)
      || entry.score < 0
      || entry.score > 5
      || !Number.isInteger(entry.score * 2)
    ) {
      errors.push(`${prefix}.score must be 0..5 in 0.5 increments or null`);
      continue;
    }
    if (entry.confidence === 'unknown') errors.push(`${prefix} assessed score cannot use confidence=unknown`);
    assessedWeight += canonical.weight;
    weightedPoints += canonical.weight * entry.score / 5;
    confidencePoints += canonical.weight * (CONFIDENCE_FACTOR[entry.confidence] ?? 0);
  }

  const coveragePercent = assessedWeight;
  const confidenceIndex = assessedWeight === 0
    ? null
    : Math.round((confidencePoints / assessedWeight) * 100) / 100;
  const confidence = assessedWeight === 0
    ? 'unknown'
    : coveragePercent === 100 && confidenceIndex >= 0.8
      ? 'high'
      : coveragePercent >= 80 && confidenceIndex >= 0.6
        ? 'medium'
        : 'low';
  return {
    weightedScore: coveragePercent === 100 ? Math.round(weightedPoints * 10) / 10 : null,
    coveragePercent,
    confidenceIndex,
    confidence,
  };
}

function validateReview(review, dimensions) {
  const errors = [];
  if (!isRecord(review)) {
    errors.push('review must be an object');
    return { errors, scoring: null };
  }
  rejectUnknownFields(review, ROOT_FIELDS, 'review', errors);
  if (review?.schemaVersion !== 2) errors.push('schemaVersion must be 2');
  if (!isRecord(review.target)) errors.push('target must be an object');
  else rejectUnknownFields(review.target, TARGET_FIELDS, 'target', errors);
  if (!nonEmpty(review?.target?.name)) errors.push('target.name is required');
  if (!/^sha256:[0-9a-f]{64}$/u.test(review?.target?.digest ?? '')) errors.push('target.digest must be sha256');
  if (!REVIEW_MODES.has(review?.mode)) errors.push('mode must be quick, full, or delta');
  if (!DESIGNS.has(review?.design)) errors.push('design is invalid');
  if (!COMPLEXITIES.has(review?.complexity)) errors.push('complexity is invalid');
  if (!nonEmpty(review?.summary)) errors.push('summary is required');
  if (!Array.isArray(review?.findings)) errors.push('findings must be an array');
  else for (const [index, finding] of review.findings.entries()) validateFinding(finding, index, errors);
  if (!Array.isArray(review?.unknowns) || review.unknowns.some((entry) => !nonEmpty(entry))) {
    errors.push('unknowns must be an array of non-empty strings');
  } else if (new Set(review.unknowns).size !== review.unknowns.length) {
    errors.push('unknowns must contain unique strings');
  }
  if (!['none', 'structural', 'executed', 'comparative'].includes(review?.evalEvidence)) {
    errors.push('evalEvidence is invalid');
  }
  const scoring = validateDimensions(review, dimensions, errors);
  if (review?.complexity === 'over-engineered' && !['redesign', 'fail'].includes(review?.design)) {
    errors.push('over-engineered complexity requires redesign or fail');
  }
  if (review?.complexity === 'over-engineered' && review?.findings?.length === 0) {
    errors.push('over-engineered complexity requires at least one evidence-based finding');
  }
  if (review?.complexity === 'over-specified' && review?.design === 'pass') {
    errors.push('over-specified complexity cannot use design=pass');
  }
  if (review?.findings?.some((finding) => finding?.severity === 'critical') && review?.design !== 'fail') {
    errors.push('critical finding requires design=fail');
  }
  if (review?.findings?.some((finding) => finding?.severity === 'major') && review?.design === 'pass') {
    errors.push('major finding cannot use design=pass');
  }
  if (
    review?.mode === 'full'
    && scoring
    && (scoring.coveragePercent < 100 || ['low', 'unknown'].includes(scoring.confidence))
    && !review?.findings?.some((finding) => finding?.severity === 'critical')
    && review?.complexity !== 'over-engineered'
    && review?.design !== 'not-assessed'
  ) {
    errors.push('incomplete or low-confidence full review requires design=not-assessed');
  }
  return { errors, scoring };
}

function validateCheck(check) {
  const errors = [];
  if (check?.schemaVersion !== 1 || check?.producer !== 'check-agent-skill') {
    errors.push('check result is not SkillCheckResult v1');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(check?.target?.digest ?? '')) {
    errors.push('check target digest is invalid');
  }
  if (typeof check?.ok !== 'boolean' || !Array.isArray(check?.errors) || !Array.isArray(check?.warnings)) {
    errors.push('check result is malformed');
  }
  return errors;
}

export async function validateReviewResultLite(review, check) {
  const dimensions = await loadDimensions();
  const reviewValidation = validateReview(review, dimensions);
  const errors = [...reviewValidation.errors, ...validateCheck(check)];
  if (errors.length === 0) {
    if (review.target.name !== check.target.name) errors.push('review target.name must match the machine check');
    if (review.target.digest !== check.target.digest) errors.push('review target.digest must match the machine check');
  }
  const effectiveDecision = check?.ok === true ? review?.design ?? null : 'fail';
  return {
    valid: errors.length === 0,
    errors,
    machineCheck: check?.ok === true ? 'pass' : 'fail',
    machineErrors: check?.errors ?? [],
    design: review?.design ?? null,
    complexity: review?.complexity ?? null,
    scoring: review?.mode === 'full' ? reviewValidation.scoring : null,
    effectiveDecision,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const [review, check] = await Promise.all([
    readFile(options.review, 'utf8').then(JSON.parse),
    readFile(options.check, 'utf8').then(JSON.parse),
  ]);
  const output = await validateReviewResultLite(review, check);
  const scoringLine = output.scoring
    ? `Score: ${output.scoring.weightedScore ?? 'not-assessed'}; coverage: ${output.scoring.coveragePercent}%; confidence: ${output.scoring.confidence}`
    : null;
  process.stdout.write(options.format === 'json' ? `${JSON.stringify(output, null, 2)}\n` : [
    output.valid ? 'ReviewResultLite is valid.' : output.errors.join('\n'),
    `Machine check: ${output.machineCheck}`,
    `Design: ${output.design}`,
    `Complexity: ${output.complexity}`,
    ...(scoringLine ? [scoringLine] : []),
    `Effective decision: ${output.effectiveDecision}`,
  ].join('\n') + '\n');
  if (!output.valid) process.exitCode = 1;
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
    process.exit(2);
  });
}
