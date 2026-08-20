#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const positional = [];
  let format = 'text';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--format') format = argv[++index];
    else if (argv[index].startsWith('-')) throw new Error('Unknown option: ' + argv[index]);
    else positional.push(path.resolve(argv[index]));
  }
  if (positional.length !== 1 || !['text', 'json'].includes(format)) {
    throw new Error('Usage: validate-aw-review-summary.mjs <summary.json> [--format text|json]');
  }
  return { summaryPath: positional[0], format };
}

async function schemaErrors(summaryPath) {
  const schemaCandidates = [
    path.join(scriptRoot, '..', 'schemas', 'aw-review-summary.schema.json'),
    path.join(scriptRoot, '..', 'assets', 'aw-review-summary.schema.json'),
  ];
  let schemaPath;
  for (const candidate of schemaCandidates) {
    try { await readFile(candidate); schemaPath = candidate; break; } catch {}
  }
  if (!schemaPath) throw new Error('Cannot locate AWReviewSummary schema.');
  const validatorCandidates = [
    path.join(scriptRoot, 'validate-json-contract.mjs'),
    path.join(scriptRoot, '..', 'skills', 'review-aw-plugin', 'scripts', 'validate-json-contract.mjs'),
  ];
  let validator;
  for (const candidate of validatorCandidates) {
    try { await readFile(candidate); validator = candidate; break; } catch {}
  }
  if (!validator) throw new Error('Cannot locate JSON contract validator.');
  try {
    const { stdout } = await execFileAsync(process.execPath, [validator, schemaPath, summaryPath, '--format', 'json'], { encoding: 'utf8' });
    return JSON.parse(stdout).errors;
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout).errors;
    throw error;
  }
}

export function expectedAwDecision(summary) {
  const gates = Object.values(summary.projectGates);
  const generic = summary.genericReviews;
  const p0Failed = gates.some((gate) => gate.status === 'fail' && gate.severity === 'P0');
  const p1Failed = gates.some((gate) => gate.status === 'fail' && gate.severity === 'P1');
  const genericDesigns = generic.map((entry) => entry.design);
  const design = p0Failed || genericDesigns.includes('fail')
    ? 'fail'
    : genericDesigns.includes('redesign')
      ? 'redesign'
      : p1Failed || genericDesigns.includes('needs-fixes')
        ? 'needs-fixes'
        : genericDesigns.includes('not-assessed')
          ? 'not-assessed'
          : 'pass';
  const blocked = p0Failed || p1Failed || generic.some((entry) => entry.releaseReadiness === 'blocked') || ['fail', 'redesign'].includes(design);
  const provisional = gates.some((gate) => gate.status === 'unknown')
    || generic.some((entry) => ['provisional', 'not-assessed'].includes(entry.releaseReadiness))
    || (summary.evalAudit !== null && (summary.evalAudit.validity !== 'pass' || !summary.evalAudit.releaseEligible));
  return {
    design,
    releaseReadiness: blocked ? 'blocked' : provisional ? 'provisional' : 'ready',
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const errors = await schemaErrors(options.summaryPath);
  if (errors.length === 0) {
    const summary = JSON.parse(await readFile(options.summaryPath, 'utf8'));
    for (const [gateId, gate] of Object.entries(summary.projectGates)) {
      if (gate.status === 'fail' && gate.findingIds.length === 0) {
        errors.push('failed project gate ' + gateId + ' must reference a finding');
      }
    }
    const expected = expectedAwDecision(summary);
    if (summary.design !== expected.design) errors.push('design must be ' + expected.design + ' for the supplied generic reviews and project gates');
    if (summary.releaseReadiness !== expected.releaseReadiness) errors.push('releaseReadiness must be ' + expected.releaseReadiness + ' for the supplied evidence');
  }
  const output = { valid: errors.length === 0, errors };
  process.stdout.write(options.format === 'json' ? JSON.stringify(output, null, 2) + '\n' : output.valid ? 'AWReviewSummary is valid.\n' : errors.join('\n') + '\n');
  if (!output.valid) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(1);
});
