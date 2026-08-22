#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

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
    if (value === '--check') check = path.resolve(argv[++index] ?? '');
    else if (value === '--format') format = argv[++index];
    else if (value.startsWith('-')) throw new Error('Unknown option: ' + value);
    else positional.push(path.resolve(value));
  }
  if (positional.length !== 1 || !check) throw new Error(usage());
  if (!['json', 'text'].includes(format)) throw new Error('--format must be json or text.');
  return { review: positional[0], check, format };
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateReview(review) {
  const errors = [];
  if (review?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!nonEmpty(review?.target?.name)) errors.push('target.name is required');
  if (!/^sha256:[0-9a-f]{64}$/u.test(review?.target?.digest ?? '')) errors.push('target.digest must be sha256');
  if (!['quick', 'full', 'delta'].includes(review?.mode)) errors.push('mode must be quick, full, or delta');
  if (!['pass', 'needs-fixes', 'redesign', 'fail', 'not-assessed'].includes(review?.design)) errors.push('design is invalid');
  if (!['proportionate', 'over-specified', 'over-engineered', 'not-assessed'].includes(review?.complexity)) errors.push('complexity is invalid');
  if (!nonEmpty(review?.summary)) errors.push('summary is required');
  if (!Array.isArray(review?.findings)) errors.push('findings must be an array');
  else for (const [index, finding] of review.findings.entries()) {
    if (!['critical', 'major', 'minor', 'advisory'].includes(finding?.severity)) errors.push(`findings[${index}].severity is invalid`);
    if (!nonEmpty(finding?.area)) errors.push(`findings[${index}].area is required`);
    if (!Array.isArray(finding?.evidence) || finding.evidence.length === 0 || finding.evidence.some((entry) => !nonEmpty(entry))) errors.push(`findings[${index}].evidence must contain source locations`);
    if (!nonEmpty(finding?.issue)) errors.push(`findings[${index}].issue is required`);
    if (!nonEmpty(finding?.action)) errors.push(`findings[${index}].action is required`);
  }
  if (!Array.isArray(review?.unknowns) || review.unknowns.some((entry) => !nonEmpty(entry))) errors.push('unknowns must be an array of non-empty strings');
  if (!['none', 'structural', 'executed', 'comparative'].includes(review?.evalEvidence)) errors.push('evalEvidence is invalid');
  if (review?.complexity === 'over-engineered' && !['redesign', 'fail'].includes(review?.design)) errors.push('over-engineered complexity requires redesign or fail');
  if (review?.complexity === 'over-engineered' && (!Array.isArray(review?.findings) || review.findings.length === 0)) errors.push('over-engineered complexity requires at least one evidence-based finding');
  if (review?.complexity === 'over-specified' && review?.design === 'pass') errors.push('over-specified complexity cannot use design=pass');
  return errors;
}

function validateCheck(check) {
  const errors = [];
  if (check?.schemaVersion !== 1 || check?.producer !== 'check-agent-skill') errors.push('check result is not SkillCheckResult v1');
  if (!/^sha256:[0-9a-f]{64}$/u.test(check?.target?.digest ?? '')) errors.push('check target digest is invalid');
  if (typeof check?.ok !== 'boolean' || !Array.isArray(check?.errors) || !Array.isArray(check?.warnings)) errors.push('check result is malformed');
  return errors;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const [review, check] = await Promise.all([
    readFile(options.review, 'utf8').then(JSON.parse),
    readFile(options.check, 'utf8').then(JSON.parse),
  ]);
  const errors = [...validateReview(review), ...validateCheck(check)];
  if (errors.length === 0) {
    if (review.target.name !== check.target.name) errors.push('review target.name must match the machine check');
    if (review.target.digest !== check.target.digest) errors.push('review target.digest must match the machine check');
  }
  const effectiveDecision = check.ok ? review.design : 'fail';
  const output = {
    valid: errors.length === 0,
    errors,
    machineCheck: check.ok ? 'pass' : 'fail',
    machineErrors: check.errors ?? [],
    design: review.design ?? null,
    complexity: review.complexity ?? null,
    effectiveDecision,
  };
  process.stdout.write(options.format === 'json' ? JSON.stringify(output, null, 2) + '\n' : [
    output.valid ? 'ReviewResultLite is valid.' : errors.join('\n'),
    `Machine check: ${output.machineCheck}`,
    `Design: ${output.design}`,
    `Complexity: ${output.complexity}`,
    `Effective decision: ${output.effectiveDecision}`,
  ].join('\n') + '\n');
  if (!output.valid) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(2);
});
