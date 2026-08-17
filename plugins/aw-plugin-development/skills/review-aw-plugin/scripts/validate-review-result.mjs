#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return 'Usage: validate-review-result.mjs <review-result.json> [--format text|json]';
}

function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true };
  const positional = [];
  let format = 'text';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--format') format = argv[++index];
    else if (value.startsWith('-')) throw new Error('Unknown option: ' + value);
    else positional.push(value);
  }
  if (positional.length !== 1) throw new Error(usage());
  if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json.');
  return { valuePath: path.resolve(positional[0]), format };
}

async function firstReadable(candidates) {
  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // Try the next generated or canonical location.
    }
  }
  throw new Error('Cannot locate ReviewResult schema or generated rules.');
}

function approximatelyEqual(left, right) {
  return Math.abs(left - right) <= 0.01;
}

async function schemaErrors(schemaPath, valuePath) {
  const validator = path.join(scriptRoot, 'validate-json-contract.mjs');
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      validator,
      schemaPath,
      valuePath,
      '--format',
      'json',
    ], { encoding: 'utf8' });
    return JSON.parse(stdout).errors;
  } catch (error) {
    const stdout = error && typeof error === 'object' ? error.stdout : null;
    if (typeof stdout === 'string' && stdout.trim()) {
      return JSON.parse(stdout).errors;
    }
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const schemaPath = await firstReadable([
    path.join(scriptRoot, '..', 'schemas', 'review-result.schema.json'),
    path.join(scriptRoot, '..', 'assets', 'review-result.schema.json'),
  ]);
  const rulesPath = await firstReadable([
    path.join(scriptRoot, '..', 'standards', 'rules.json'),
    path.join(scriptRoot, '..', 'assets', 'review-result-rules.generated.json'),
  ]);
  const errors = await schemaErrors(schemaPath, options.valuePath);
  let calculated = { weightedScore: null, coverage: null };

  if (errors.length === 0) {
    const [result, rules] = await Promise.all([
      readFile(options.valuePath, 'utf8').then(JSON.parse),
      readFile(rulesPath, 'utf8').then(JSON.parse),
    ]);
    const expectedDimensions = new Map(
      rules.dimensions.map((dimension) => [dimension.id, dimension.weight]),
    );
    const dimensions = new Map();
    for (const dimension of result.dimensions) {
      if (dimensions.has(dimension.id)) {
        errors.push('dimensions contains duplicate id ' + dimension.id);
      }
      dimensions.set(dimension.id, dimension);
      const expectedWeight = expectedDimensions.get(dimension.id);
      if (expectedWeight !== undefined && dimension.weight !== expectedWeight) {
        errors.push(
          'dimension ' + dimension.id + ' must use canonical weight ' + expectedWeight,
        );
      }
    }

    const scoredMode = ['full', 'release-quality'].includes(result.mode);
    if (scoredMode) {
      for (const id of expectedDimensions.keys()) {
        if (!dimensions.has(id)) errors.push('scored review is missing dimension ' + id);
      }
      if (dimensions.size !== expectedDimensions.size) {
        errors.push('scored review must contain each canonical dimension exactly once');
      }
    } else if (result.weightedScore !== null) {
      errors.push('quick and delta reviews must set weightedScore to null');
    }

    const findingIds = new Set();
    const findingById = new Map();
    for (const finding of result.findings) {
      if (findingIds.has(finding.id)) errors.push('findings contains duplicate id ' + finding.id);
      findingIds.add(finding.id);
      findingById.set(finding.id, finding);
      if (
        ['P0', 'P1'].includes(finding.severity)
      ) {
        if (!finding.evidenceTypes.some((type) =>
          ['observed', 'normative', 'structural'].includes(type))) {
          errors.push(finding.id + ' requires observed, normative, or structural evidence');
        }
        if (finding.evidence.length === 0) {
          errors.push(finding.id + ' requires direct evidence');
        }
        if (finding.premises.length === 0 || finding.premises.some((premise) => premise.status !== 'supported')) {
          errors.push(finding.id + ' requires supported premises');
        }
        if (finding.reachability.status !== 'supported') {
          errors.push(finding.id + ' requires supported reachability');
        }
        if (finding.counterevidence.length === 0) {
          errors.push(finding.id + ' must record counterevidence considered');
        }
      }
    }
    const unknownIds = new Set();
    for (const unknown of result.unknowns) {
      if (unknownIds.has(unknown.id)) errors.push('unknowns contains duplicate id ' + unknown.id);
      unknownIds.add(unknown.id);
    }

    let assessedWeight = 0;
    let weightedPoints = 0;
    for (const dimension of result.dimensions) {
      for (const findingId of dimension.findingIds) {
        if (!findingIds.has(findingId)) {
          errors.push('dimension ' + dimension.id + ' references unknown finding ' + findingId);
        }
      }
      for (const unknownId of dimension.unknownIds) {
        if (!unknownIds.has(unknownId)) {
          errors.push('dimension ' + dimension.id + ' references unknown unknown ' + unknownId);
        }
      }
      if (
        dimension.score !== null
        && dimension.score < 5
        && dimension.findingIds.length === 0
        && dimension.unknownIds.length === 0
      ) {
        errors.push('dimension ' + dimension.id + ' score below 5 requires a finding or unknown');
      }
      if (dimension.score !== null) {
        assessedWeight += dimension.weight;
        weightedPoints += dimension.weight * dimension.score / 5;
      }
    }
    const totalWeight = [...expectedDimensions.values()]
      .reduce((total, weight) => total + weight, 0);
    calculated = {
      weightedScore: assessedWeight === totalWeight ? weightedPoints / assessedWeight * 100 : null,
      coverage: assessedWeight / [...expectedDimensions.values()]
        .reduce((total, weight) => total + weight, 0) * 100,
    };
    if (!approximatelyEqual(result.coverage, calculated.coverage)) {
      errors.push('coverage does not match assessed canonical dimension weight');
    }
    if (
      (
        (calculated.weightedScore === null && result.weightedScore !== null)
        || (
          calculated.weightedScore !== null
          && (
            result.weightedScore === null
            || !approximatelyEqual(result.weightedScore, calculated.weightedScore)
          )
        )
      )
    ) {
      errors.push('weightedScore does not match canonical dimension calculation');
    }

    const confidencePoints = { high: 1, medium: 0.7, low: 0.4, unknown: 0 };
    let confidenceWeight = 0;
    let weightedConfidence = 0;
    for (const dimension of result.dimensions) {
      if (dimension.score === null) continue;
      confidenceWeight += dimension.weight;
      weightedConfidence += dimension.weight * confidencePoints[dimension.confidence];
    }
    const confidenceIndex = confidenceWeight === 0 ? null : weightedConfidence / confidenceWeight;
    const expectedConfidence = confidenceIndex === null
      ? 'unknown'
      : calculated.coverage === 100 && confidenceIndex >= 0.8
        ? 'high'
        : calculated.coverage >= 80 && confidenceIndex >= 0.6
          ? 'medium'
          : 'low';
    if (result.confidence !== expectedConfidence) {
      errors.push('confidence does not match assessed dimension confidence and coverage');
    }

    for (const [gateId, gate] of Object.entries(result.gates)) {
      if (gate.status === 'fail' && gate.findingIds.length === 0) {
        errors.push('failed gate ' + gateId + ' must reference a finding');
      }
      for (const findingId of gate.findingIds) {
        if (!findingIds.has(findingId)) {
          errors.push('gate ' + gateId + ' references unknown finding ' + findingId);
        }
      }
      if (
        gate.status === 'fail'
        && !gate.findingIds.some((findingId) => findingById.get(findingId)?.severity === gate.severity)
      ) {
        errors.push('failed gate ' + gateId + ' must reference a ' + gate.severity + ' finding');
      }
    }

    const hasP0 = result.findings.some((finding) => finding.severity === 'P0')
      || Object.values(result.gates).some((gate) => gate.status === 'fail' && gate.severity === 'P0');
    const hasP1 = result.findings.some((finding) => finding.severity === 'P1')
      || Object.values(result.gates).some((gate) => gate.status === 'fail' && gate.severity === 'P1');
    const requiresRedesign = ['overloaded', 'orchestrator-needed']
      .includes(result.composition)
      || result.complexity === 'over-engineered';
    const scoredIncomplete = scoredMode && (
      !approximatelyEqual(calculated.coverage, 100) || expectedConfidence === 'low'
    );
    const expectedDesign = hasP0
      ? 'fail'
      : requiresRedesign
        ? 'redesign'
        : hasP1 || result.complexity === 'over-specified'
          ? 'needs-fixes'
          : ['quick', 'delta'].includes(result.mode) || scoredIncomplete
            ? 'not-assessed'
            : 'pass';
    if (result.design !== expectedDesign) {
      errors.push('design must be ' + expectedDesign + ' for the supplied evidence and coverage');
    }
    const hasUnknownGate = Object.values(result.gates).some((gate) => gate.status === 'unknown');
    const expectedRelease = hasP0 || hasP1 || ['fail', 'redesign'].includes(expectedDesign)
      ? 'blocked'
      : ['quick', 'delta'].includes(result.mode)
        ? 'not-assessed'
        : hasUnknownGate || result.complexity === 'over-specified' || scoredIncomplete
          ? 'provisional'
          : 'ready';
    if (result.releaseReadiness !== expectedRelease) {
      errors.push('releaseReadiness must be ' + expectedRelease + ' for the supplied gates and decision');
    }
  }

  const output = {
    valid: errors.length === 0,
    errors,
    calculated: {
      weightedScore: calculated.weightedScore === null
        ? null
        : Number(calculated.weightedScore.toFixed(2)),
      coverage: calculated.coverage === null
        ? null
        : Number(calculated.coverage.toFixed(2)),
    },
  };
  if (options.format === 'json') process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  else process.stdout.write(output.valid ? 'ReviewResult is valid.\n' : errors.join('\n') + '\n');
  if (!output.valid) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write('[ERROR] ' + error.message + '\n');
  process.exit(1);
});
