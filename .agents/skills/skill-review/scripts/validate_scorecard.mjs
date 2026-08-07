#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DIMENSIONS = {
  specification: ['Specification & package integrity', 8],
  problem_value: ['Problem grounding & value', 8],
  triggering: ['Triggering & description', 12],
  scope_composition: ['Scope, boundaries & composition', 10],
  instruction_design: ['Instruction design & calibration', 10],
  context_disclosure: ['Context & progressive disclosure', 10],
  architecture: ['Architecture ownership', 10],
  scripts: ['Scripts & deterministic automation', 8],
  resources: ['References/assets/resources', 6],
  evals: ['Evals & evidence-driven iteration', 10],
  reliability: ['Reliability/safety/compatibility', 4],
  maintainability: ['Maintainability/change discipline', 4],
};

const REQUIRED_GATES = new Set([
  'package-validity',
  'critical-artifacts',
  'goal-alignment',
  'capability-validity',
  'safety-permissions',
  'architecture-ownership',
  'release-evidence',
]);
const CONFIDENCE_VALUES = { high: 1, medium: 0.7, low: 0.4, unknown: 0 };
const VALID_MODES = new Set(['quick', 'full', 'release', 'delta']);
const VALID_DIRECTIONS = new Set(['aligned', 'at-risk', 'drifted']);
const VALID_GATE_STATUS = new Set(['pass', 'fail', 'unknown', 'not_applicable']);
const VALID_SEVERITY = new Set(['P0', 'P1', 'P2', 'Advisory']);
const VALID_EVIDENCE = new Set(['observed', 'documented', 'inferred']);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnostic(level, code, message) {
  return { level, code, message };
}

function qualityBand(score) {
  if (score === null) return null;
  if (score >= 90) return 'excellent';
  if (score >= 80) return 'strong';
  if (score >= 70) return 'adequate';
  if (score >= 60) return 'weak';
  return 'poor';
}

function confidenceLabel(index, coverage) {
  if (index === null || coverage < 60) return 'low';
  if (coverage === 100 && index >= 0.8) return 'high';
  if (coverage >= 80 && index >= 0.6) return 'medium';
  return 'low';
}

function validateAndCalculate(data) {
  const diagnostics = [];
  const review = isRecord(data.review) ? data.review : {};
  if (!isRecord(data.review)) {
    diagnostics.push(diagnostic('error', 'review.missing', 'review must be an object.'));
  }
  const mode = review.mode;
  const direction = review.direction;
  if (!VALID_MODES.has(mode)) {
    diagnostics.push(diagnostic('error', 'review.mode', `mode must be one of ${[...VALID_MODES].sort().join(', ')}.`));
  }
  if (!VALID_DIRECTIONS.has(direction)) {
    diagnostics.push(diagnostic('error', 'review.direction', `direction must be one of ${[...VALID_DIRECTIONS].sort().join(', ')}.`));
  }

  const artifacts = isRecord(data.artifacts) ? data.artifacts : {};
  if (!isRecord(data.artifacts)) {
    diagnostics.push(diagnostic('error', 'artifacts.type', 'artifacts must be an object.'));
  }

  const rawDimensions = Array.isArray(data.dimensions) ? data.dimensions : [];
  if (!Array.isArray(data.dimensions)) {
    diagnostics.push(diagnostic('error', 'dimensions.type', 'dimensions must be a list.'));
  }
  const seen = new Set();
  const scoredRows = [];
  let assessedWeight = 0;
  let weightedPoints = 0;
  let confidencePoints = 0;

  for (const item of rawDimensions) {
    if (!isRecord(item)) {
      diagnostics.push(diagnostic('error', 'dimension.item', 'Every dimension entry must be an object.'));
      continue;
    }
    const dimensionId = item.id;
    if (!Object.hasOwn(DIMENSIONS, dimensionId)) {
      diagnostics.push(diagnostic('error', 'dimension.id', `Unknown dimension id: ${JSON.stringify(dimensionId)}.`));
      continue;
    }
    if (seen.has(dimensionId)) {
      diagnostics.push(diagnostic('error', 'dimension.duplicate', `Duplicate dimension: ${dimensionId}.`));
      continue;
    }
    seen.add(dimensionId);
    const [title, weight] = DIMENSIONS[dimensionId];
    let score = item.score ?? null;
    let confidence = item.confidence ?? 'unknown';
    let evidence = item.evidence ?? [];
    let summary = item.summary ?? '';

    if (!Object.hasOwn(CONFIDENCE_VALUES, confidence)) {
      diagnostics.push(diagnostic('error', 'dimension.confidence', `Invalid confidence for ${dimensionId}: ${JSON.stringify(confidence)}.`));
      confidence = 'unknown';
    }
    if (!Array.isArray(evidence) || evidence.some((value) => typeof value !== 'string')) {
      diagnostics.push(diagnostic('error', 'dimension.evidence', `evidence for ${dimensionId} must be a list of strings.`));
      evidence = [];
    }
    if (typeof summary !== 'string') {
      diagnostics.push(diagnostic('error', 'dimension.summary', `summary for ${dimensionId} must be a string.`));
      summary = '';
    }
    if (score !== null) {
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 5) {
        diagnostics.push(diagnostic('error', 'dimension.score', `score for ${dimensionId} must be null or a number from 0 to 5.`));
        score = null;
      } else if (!Number.isInteger(score * 2)) {
        diagnostics.push(diagnostic('error', 'dimension.step', `score for ${dimensionId} must use 0.5 increments.`));
        score = null;
      }
    }

    let weighted = null;
    if (score !== null) {
      assessedWeight += weight;
      weighted = weight * score / 5;
      weightedPoints += weighted;
      confidencePoints += weight * CONFIDENCE_VALUES[confidence];
      if (evidence.length === 0) {
        diagnostics.push(diagnostic('warning', 'dimension.no-evidence', `${dimensionId} has a score but no evidence location.`));
      }
    }
    scoredRows.push({
      id: dimensionId,
      title,
      weight,
      score,
      weighted,
      confidence,
      evidence,
      summary,
    });
  }

  const missingDimensions = Object.keys(DIMENSIONS).filter((id) => !seen.has(id)).sort();
  if (missingDimensions.length > 0) {
    diagnostics.push(diagnostic('error', 'dimension.missing', `Missing dimensions: ${missingDimensions.join(', ')}`));
  }

  const coverage = assessedWeight;
  const totalScore = assessedWeight > 0 ? weightedPoints / assessedWeight * 100 : null;
  const confidenceIndex = assessedWeight > 0 ? confidencePoints / assessedWeight : null;
  const rowById = Object.fromEntries(scoredRows.map((row) => [row.id, row]));
  if (rowById.triggering?.score > 3 && !artifacts.trigger_eval_results) {
    diagnostics.push(diagnostic('warning', 'cap.triggering', 'Triggering score exceeds 3 without trigger eval results; explain the exception or lower the score.'));
  }
  if (rowById.evals?.score > 2 && !(artifacts.trigger_eval_results || artifacts.behavior_eval_results || artifacts.runtime_traces)) {
    diagnostics.push(diagnostic('warning', 'cap.evals', 'Evals score exceeds 2 without eval results or runtime traces.'));
  }
  if (artifacts.scripts_present && rowById.scripts?.score > 3 && !artifacts.scripts_checked) {
    diagnostics.push(diagnostic('warning', 'cap.scripts', 'Scripts score exceeds 3 although scripts were not checked.'));
  }
  if (artifacts.compatibility_claims && rowById.reliability?.score > 3 && !artifacts.compatibility_verified) {
    diagnostics.push(diagnostic('warning', 'cap.reliability', 'Reliability score exceeds 3 with unverified compatibility claims.'));
  }
  if (mode === 'delta' && rowById.maintainability?.score > 3 && !artifacts.previous_version) {
    diagnostics.push(diagnostic('warning', 'cap.delta', 'Maintainability score exceeds 3 in delta mode without a previous version.'));
  }

  const rawGates = Array.isArray(data.gates) ? data.gates : [];
  if (!Array.isArray(data.gates)) {
    diagnostics.push(diagnostic('error', 'gates.type', 'gates must be a list.'));
  }
  const gates = [];
  const gateIds = new Set();
  for (const gate of rawGates) {
    if (!isRecord(gate)) {
      diagnostics.push(diagnostic('error', 'gate.item', 'Every gate must be an object.'));
      continue;
    }
    const gateId = gate.id;
    const status = gate.status;
    const severity = gate.severity;
    let reason = gate.reason ?? '';
    if (typeof gateId !== 'string') {
      diagnostics.push(diagnostic('error', 'gate.id', 'Gate id must be a string.'));
      continue;
    }
    if (gateIds.has(gateId)) {
      diagnostics.push(diagnostic('error', 'gate.duplicate', `Duplicate gate: ${gateId}.`));
      continue;
    }
    gateIds.add(gateId);
    if (!VALID_GATE_STATUS.has(status)) diagnostics.push(diagnostic('error', 'gate.status', `Invalid status for ${gateId}: ${JSON.stringify(status)}.`));
    if (!VALID_SEVERITY.has(severity)) diagnostics.push(diagnostic('error', 'gate.severity', `Invalid severity for ${gateId}: ${JSON.stringify(severity)}.`));
    if (typeof reason !== 'string') {
      diagnostics.push(diagnostic('error', 'gate.reason', `Reason for ${gateId} must be a string.`));
      reason = '';
    }
    if ((status === 'fail' || status === 'unknown') && reason.trim() === '') {
      diagnostics.push(diagnostic('warning', 'gate.no-reason', `Gate ${gateId} is ${status} but has no reason.`));
    }
    gates.push({ id: gateId, status, severity, reason });
  }
  const missingGates = [...REQUIRED_GATES].filter((id) => !gateIds.has(id)).sort();
  if (missingGates.length > 0) diagnostics.push(diagnostic('error', 'gate.missing', `Missing required gates: ${missingGates.join(', ')}`));

  const rawFindings = Array.isArray(data.findings) ? data.findings : [];
  if (!Array.isArray(data.findings)) diagnostics.push(diagnostic('error', 'findings.type', 'findings must be a list.'));
  const findings = [];
  for (let index = 0; index < rawFindings.length; index += 1) {
    const finding = rawFindings[index];
    if (!isRecord(finding)) {
      diagnostics.push(diagnostic('error', 'finding.item', `Finding #${index + 1} must be an object.`));
      continue;
    }
    if (!VALID_SEVERITY.has(finding.severity)) diagnostics.push(diagnostic('error', 'finding.severity', `Finding #${index + 1} has invalid severity ${JSON.stringify(finding.severity)}.`));
    if (!VALID_EVIDENCE.has(finding.evidence_type)) diagnostics.push(diagnostic('error', 'finding.evidence-type', `Finding #${index + 1} has invalid evidence_type ${JSON.stringify(finding.evidence_type)}.`));
    if (!Object.hasOwn(DIMENSIONS, finding.dimension)) diagnostics.push(diagnostic('error', 'finding.dimension', `Finding #${index + 1} has invalid dimension ${JSON.stringify(finding.dimension)}.`));
    if ((finding.severity === 'P0' || finding.severity === 'P1') && finding.evidence_type === 'inferred' && finding.direct_contradiction !== true) {
      diagnostics.push(diagnostic('error', 'finding.inferred-severity', `Finding #${index + 1} is inferred but marked ${finding.severity}; lower severity or mark a direct contradiction with evidence.`));
    }
    findings.push(finding);
  }

  const hasP0Gate = gates.some((gate) => gate.status === 'fail' && gate.severity === 'P0');
  const hasP1Gate = gates.some((gate) => gate.status === 'fail' && gate.severity === 'P1');
  const hasP0Finding = findings.some((finding) => finding.severity === 'P0');
  const hasP1Finding = findings.some((finding) => finding.severity === 'P1');
  const criticalUnknown = gates.some((gate) => gate.status === 'unknown' && REQUIRED_GATES.has(gate.id));
  let release;
  if (hasP0Gate || hasP0Finding) release = 'fail';
  else if (hasP1Gate || hasP1Finding) release = 'pass-after-fixes';
  else if (mode === 'quick') release = 'provisional';
  else if (mode === 'release' && (coverage < 100 || criticalUnknown)) release = 'provisional';
  else if (totalScore === null) release = 'provisional';
  else if (totalScore >= 85) release = 'pass';
  else if (totalScore >= 70) release = 'pass-after-fixes';
  else release = 'redesign';

  const errorCount = diagnostics.filter((entry) => entry.level === 'error').length;
  return {
    review,
    score: {
      weighted_score: totalScore === null ? null : Number(totalScore.toFixed(1)),
      coverage_percent: Number(coverage.toFixed(1)),
      confidence_index: confidenceIndex === null ? null : Number(confidenceIndex.toFixed(2)),
      confidence: confidenceLabel(confidenceIndex, coverage),
      quality_band: qualityBand(totalScore),
      release,
    },
    dimensions: scoredRows,
    gates,
    findings,
    diagnostics,
    valid: errorCount === 0,
  };
}

function renderText(result) {
  const score = result.score;
  const lines = [
    `Skill: ${result.review.skill_name ?? ''}`,
    `Mode / direction: ${result.review.mode ?? ''} / ${result.review.direction ?? ''}`,
    `Score: ${score.weighted_score} / 100 (${score.quality_band})`,
    `Coverage: ${score.coverage_percent}%`,
    `Confidence: ${score.confidence} (${score.confidence_index})`,
    `Release: ${score.release}`,
    'Dimensions:',
  ];
  for (const row of result.dimensions) {
    const scoreText = row.score === null ? 'not assessed' : `${row.score.toFixed(1)}/5`;
    const weighted = row.weighted === null ? '-' : row.weighted.toFixed(1);
    lines.push(`  - ${row.id}: ${scoreText}, weighted ${weighted}, confidence ${row.confidence}`);
  }
  lines.push('Diagnostics:');
  if (result.diagnostics.length === 0) lines.push('  none');
  else for (const entry of result.diagnostics) lines.push(`  [${entry.level}] ${entry.code}: ${entry.message}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  let scorecard;
  let format = 'text';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--format') {
      format = argv[++index];
      if (!format) throw new Error('--format requires a value.');
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!scorecard) scorecard = path.resolve(arg);
    else throw new Error('Only one scorecard may be supplied.');
  }
  if (!scorecard) throw new Error('Usage: validate_scorecard.mjs <scorecard.json> [--format text|json]');
  if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json.');
  return { scorecard, format };
}

async function main() {
  try {
    if (process.argv.slice(2).includes('--help')) {
      process.stdout.write('Usage: validate_scorecard.mjs <scorecard.json> [--format text|json]\n');
      return;
    }
    const options = parseArgs(process.argv.slice(2));
    const data = JSON.parse(await readFile(options.scorecard, 'utf8'));
    if (!isRecord(data)) throw new Error('Scorecard top level must be a JSON object.');
    const result = validateAndCalculate(data);
    process.stdout.write(options.format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : `${renderText(result)}\n`);
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

export { validateAndCalculate };
