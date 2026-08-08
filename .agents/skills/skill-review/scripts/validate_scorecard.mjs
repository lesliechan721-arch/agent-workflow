#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DIMENSIONS = {
  specification: ['Specification & package integrity', 7],
  problem_value: ['Problem grounding & value', 8],
  triggering: ['Invocation, triggering & context pointers', 12],
  scope_composition: ['Scope, boundaries & composition', 8],
  instruction_design: ['Program, completion bounds & calibration', 12],
  context_disclosure: ['Information hierarchy & progressive disclosure', 12],
  architecture: ['Architecture ownership', 10],
  scripts: ['Scripts & deterministic automation', 8],
  resources: ['Resource reachability & co-location', 5],
  evals: ['Evals & evidence-driven iteration', 10],
  reliability: ['Reliability, safety & compatibility', 4],
  maintainability: ['Pruning, source of truth & change discipline', 4],
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
const VALID_EVIDENCE = new Set([
  'observed',
  'normative',
  'structural',
  'heuristic',
  'inferred',
]);
const STRONG_EVIDENCE = new Set(['observed', 'normative', 'structural']);
const VALID_OWNERS = new Set([
  'Skill',
  'Schema',
  'Client',
  'Runtime',
  'Script',
  'Role',
  'Eval',
  'Project',
  'User',
]);

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

function pythonTruthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function roundPythonFloat(value, digits) {
  if (!Number.isFinite(value) || !Number.isInteger(digits) || digits < 0) {
    throw new Error('roundPythonFloat requires a finite number and non-negative integer digits.');
  }
  if (value === 0) return value;

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const negative = (bits >> 63n) === 1n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  let numerator = exponent === 0 ? fraction : (1n << 52n) | fraction;
  const binaryExponent = exponent === 0 ? -1074 : exponent - 1023 - 52;
  let denominator = 1n;
  if (binaryExponent >= 0) numerator <<= BigInt(binaryExponent);
  else denominator <<= BigInt(-binaryExponent);

  const scale = 10n ** BigInt(digits);
  const scaledNumerator = numerator * scale;
  let quotient = scaledNumerator / denominator;
  const remainder = scaledNumerator % denominator;
  if (
    remainder * 2n > denominator ||
    (remainder * 2n === denominator && quotient % 2n !== 0n)
  ) {
    quotient += 1n;
  }
  const rounded = Number(quotient) / Number(scale);
  return negative ? -rounded : rounded;
}

function normalizedEvidenceTypes(finding, index, diagnostics) {
  let raw = finding.evidence_types;
  if ((raw === undefined || raw === null) && Object.hasOwn(finding, 'evidence_type')) {
    raw = [finding.evidence_type];
    diagnostics.push(diagnostic(
      'warning',
      'finding.legacy-evidence-type',
      `Finding #${index} uses legacy evidence_type; use evidence_types array.`,
    ));
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    diagnostics.push(diagnostic(
      'error',
      'finding.evidence-types',
      `Finding #${index} must contain a non-empty evidence_types array.`,
    ));
    return [];
  }
  const values = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !VALID_EVIDENCE.has(value)) {
      diagnostics.push(diagnostic(
        'error',
        'finding.evidence-type',
        `Finding #${index} has invalid evidence type ${JSON.stringify(value)}; allowed: ${[...VALID_EVIDENCE].sort().join(', ')}.`,
      ));
      continue;
    }
    if (!values.includes(value)) values.push(value);
  }
  return values;
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
  if (data.artifacts !== undefined && !isRecord(data.artifacts)) {
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
    let score = Object.hasOwn(item, 'score') ? item.score : null;
    let confidence = Object.hasOwn(item, 'confidence') ? item.confidence : 'unknown';
    let evidence = Object.hasOwn(item, 'evidence') ? item.evidence : [];
    let summary = Object.hasOwn(item, 'summary') ? item.summary : '';

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
  const confidenceIndex = assessedWeight > 0
    ? confidencePoints / assessedWeight
    : null;
  const rowById = Object.fromEntries(scoredRows.map((row) => [row.id, row]));
  const capWarning = (dimensionId, maximum, condition, code, message) => {
    const score = rowById[dimensionId]?.score;
    if (score !== null && score !== undefined && score > maximum && !condition) {
      diagnostics.push(diagnostic('warning', code, message));
    }
  };
  capWarning(
    'triggering',
    3,
    pythonTruthy(artifacts.trigger_eval_results),
    'cap.triggering-eval',
    'Triggering score exceeds 3 without trigger eval results; explain or lower the score.',
  );
  capWarning(
    'triggering',
    4,
    pythonTruthy(artifacts.pointer_audit),
    'cap.triggering-pointer',
    'Triggering score exceeds 4 without an invocation/pointer audit.',
  );
  capWarning(
    'instruction_design',
    4,
    pythonTruthy(artifacts.completion_boundary_audit),
    'cap.completion-boundary',
    'Instruction-design score exceeds 4 without a completion-boundary audit.',
  );
  capWarning(
    'context_disclosure',
    4,
    pythonTruthy(artifacts.information_hierarchy_map),
    'cap.information-hierarchy',
    'Context/disclosure score exceeds 4 without an information-hierarchy map.',
  );
  capWarning(
    'evals',
    2,
    [
      artifacts.trigger_eval_results,
      artifacts.behavior_eval_results,
      artifacts.regression_eval_results,
      artifacts.ablation_results,
      artifacts.runtime_traces,
    ].some(pythonTruthy),
    'cap.evals',
    'Evals score exceeds 2 without eval results, ablation, or runtime traces.',
  );
  if (pythonTruthy(artifacts.scripts_present)) {
    capWarning(
      'scripts',
      3,
      pythonTruthy(artifacts.scripts_checked),
      'cap.scripts',
      'Scripts score exceeds 3 although scripts were not checked.',
    );
  }
  if (pythonTruthy(artifacts.compatibility_claims)) {
    capWarning(
      'reliability',
      3,
      pythonTruthy(artifacts.compatibility_verified),
      'cap.reliability',
      'Reliability score exceeds 3 with unverified compatibility claims.',
    );
  }
  if (mode === 'delta') {
    capWarning(
      'maintainability',
      3,
      pythonTruthy(artifacts.previous_version),
      'cap.delta',
      'Maintainability score exceeds 3 in delta mode without a previous version.',
    );
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
    let reason = Object.hasOwn(gate, 'reason') ? gate.reason : '';
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
  if (data.findings !== undefined && !Array.isArray(data.findings)) {
    diagnostics.push(diagnostic('error', 'findings.type', 'findings must be a list.'));
  }
  const findings = [];
  const findingIds = new Set();
  for (let offset = 0; offset < rawFindings.length; offset += 1) {
    const index = offset + 1;
    const finding = rawFindings[offset];
    if (!isRecord(finding)) {
      diagnostics.push(diagnostic('error', 'finding.item', `Finding #${index} must be an object.`));
      continue;
    }
    let findingId = Object.hasOwn(finding, 'id') ? finding.id : `finding-${index}`;
    const evidenceTypes = normalizedEvidenceTypes(finding, index, diagnostics);
    if (typeof findingId !== 'string' || findingId.trim() === '') {
      diagnostics.push(diagnostic('error', 'finding.id', `Finding #${index} must have a non-empty id.`));
      findingId = `finding-${index}`;
    }
    if (findingIds.has(findingId)) {
      diagnostics.push(diagnostic('error', 'finding.duplicate', `Duplicate finding id: ${findingId}.`));
    }
    findingIds.add(findingId);
    if (!VALID_SEVERITY.has(finding.severity)) {
      diagnostics.push(diagnostic('error', 'finding.severity', `Finding #${index} has invalid severity ${JSON.stringify(finding.severity)}.`));
    }
    if (!Object.hasOwn(DIMENSIONS, finding.dimension)) {
      diagnostics.push(diagnostic('error', 'finding.dimension', `Finding #${index} has invalid dimension ${JSON.stringify(finding.dimension)}.`));
    }
    if (
      (finding.severity === 'P0' || finding.severity === 'P1') &&
      !evidenceTypes.some((value) => STRONG_EVIDENCE.has(value))
    ) {
      diagnostics.push(diagnostic(
        'error',
        'finding.authority-severity',
        `Finding #${index} is ${finding.severity} but has no observed, normative, or structural evidence.`,
      ));
    }
    const owner = finding.correct_owner ?? '';
    if (owner !== '' && !VALID_OWNERS.has(owner)) {
      diagnostics.push(diagnostic(
        'warning',
        'finding.owner',
        `Finding #${index} uses non-standard owner ${JSON.stringify(owner)}; expected one of ${[...VALID_OWNERS].sort().join(', ')}.`,
      ));
    }
    if (finding.severity === 'P0' || finding.severity === 'P1') {
      for (const field of ['location', 'problem', 'correct_owner', 'minimal_change', 'validation']) {
        if (typeof finding[field] !== 'string' || finding[field].trim() === '') {
          diagnostics.push(diagnostic(
            'error',
            'finding.required-field',
            `Finding #${index} (${finding.severity}) requires non-empty field ${JSON.stringify(field)}.`,
          ));
        }
      }
    }
    const normalized = { ...finding, id: findingId, evidence_types: evidenceTypes };
    delete normalized.evidence_type;
    findings.push(normalized);
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
  else if (
    mode === 'release' &&
    (coverage < 100 || criticalUnknown || !pythonTruthy(artifacts.current_sources_checked))
  ) release = 'provisional';
  else if (mode === 'delta' && !pythonTruthy(artifacts.previous_version)) release = 'provisional';
  else if (totalScore === null) release = 'provisional';
  else if (totalScore >= 85) release = 'pass';
  else if (totalScore >= 70) release = 'pass-after-fixes';
  else release = 'redesign';

  const errorCount = diagnostics.filter((entry) => entry.level === 'error').length;
  return {
    review,
    score: {
      weighted_score: totalScore === null
        ? null
        : roundPythonFloat(totalScore, 1),
      coverage_percent: coverage,
      confidence_index: confidenceIndex === null
        ? null
        : roundPythonFloat(confidenceIndex, 2),
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
