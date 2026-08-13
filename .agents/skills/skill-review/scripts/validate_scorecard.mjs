#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DIMENSIONS = {
  specification: ['Specification & package integrity', 6],
  problem_value: ['Problem grounding & value', 8],
  triggering: ['Invocation, triggering & context pointers', 10],
  scope_composition: ['Scope, boundaries & composition', 8],
  instruction_design: ['Program & completion bounds', 10],
  minimum_control: ['Minimum necessary control & model latitude', 14],
  context_disclosure: ['Information hierarchy, resources & disclosure', 10],
  architecture: ['Architecture ownership', 10],
  scripts: ['Scripts & deterministic automation', 7],
  evals: ['Eval design, oracle validity & change safety', 9],
  reliability: ['Reliability, safety & compatibility', 4],
  maintainability: ['Pruning, source of truth & change discipline', 4],
};

const REQUIRED_GATES = new Map([
  ['package-validity', 'P0'],
  ['critical-artifacts', 'P0'],
  ['goal-alignment', 'P0'],
  ['capability-validity', 'P0'],
  ['safety-permissions', 'P0'],
  ['architecture-ownership', 'P1'],
  ['release-evidence', 'P1'],
  ['eval-validity', 'P1'],
  ['eval-change-safety', 'P1'],
]);
const CONFIDENCE_VALUES = { high: 1, medium: 0.7, low: 0.4, unknown: 0 };
const VALID_MODES = new Set(['quick', 'full', 'release', 'delta']);
const VALID_DIRECTIONS = new Set(['aligned', 'at-risk', 'drifted']);
const VALID_COMPLEXITY_VERDICTS = new Set([
  'minimal',
  'proportionate',
  'over-specified',
  'over-engineered',
]);
const VALID_REDUCIBILITY = new Set([
  'almost-none',
  'minor',
  'significant',
  'core-plus-reference',
  'redesign',
]);
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
const VALID_PREMISE_STATUS = new Set(['supported', 'unsupported', 'unknown']);
const VALID_REACHABILITY_KIND = new Set(['entry-gate', 'execution-path']);
const ARTIFACT_FIELDS = new Set([
  'official_validation',
  'current_sources_checked',
  'pointer_audit',
  'information_hierarchy_map',
  'completion_boundary_audit',
  'minimum_effective_control_audit',
  'trigger_eval_results',
  'behavior_eval_results',
  'regression_eval_results',
  'ablation_results',
  'runtime_traces',
  'eval_audit_applicable',
  'eval_case_audit',
  'eval_error_cost_policy',
  'eval_baseline_assessed',
  'eval_variance_assessed',
  'eval_failure_triage',
  'eval_driven_change',
  'eval_change_regressions',
  'eval_known_invalid_oracle',
  'scripts_present',
  'scripts_checked',
  'compatibility_claims',
  'compatibility_verified',
  'previous_version',
]);
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

function effectiveQualityBand(rawBand, complexityVerdict) {
  if (rawBand === null) return null;
  const order = ['poor', 'weak', 'adequate', 'strong', 'excellent'];
  const caps = {
    'over-specified': 'adequate',
    'over-engineered': 'weak',
  };
  const cap = caps[complexityVerdict];
  if (!cap) return rawBand;
  return order[Math.min(order.indexOf(rawBand), order.indexOf(cap))];
}

function confidenceLabel(index, coverage) {
  if (index === null || coverage < 60) return 'low';
  if (coverage === 100 && index >= 0.8) return 'high';
  if (coverage >= 80 && index >= 0.6) return 'medium';
  return 'low';
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

function normalizedMaterialPremises(finding, index, diagnostics) {
  const raw = finding.material_premises;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    diagnostics.push(diagnostic(
      'error',
      'finding.material-premises',
      `Finding #${index} material_premises must be a list.`,
    ));
    return [];
  }
  const values = [];
  for (let offset = 0; offset < raw.length; offset += 1) {
    const premise = raw[offset];
    if (!isRecord(premise)) {
      diagnostics.push(diagnostic(
        'error',
        'finding.material-premise',
        `Finding #${index} material premise #${offset + 1} must be an object.`,
      ));
      continue;
    }
    let valid = true;
    for (const field of ['premise', 'source_role', 'evidence']) {
      if (typeof premise[field] !== 'string' || premise[field].trim() === '') {
        diagnostics.push(diagnostic(
          'error',
          'finding.material-premise-field',
          `Finding #${index} material premise #${offset + 1} requires non-empty field ${JSON.stringify(field)}.`,
        ));
        valid = false;
      }
    }
    if (!VALID_PREMISE_STATUS.has(premise.status)) {
      diagnostics.push(diagnostic(
        'error',
        'finding.material-premise-status',
        `Finding #${index} material premise #${offset + 1} has invalid status ${JSON.stringify(premise.status)}.`,
      ));
      valid = false;
    }
    if (valid) values.push(premise);
  }
  return values;
}

function normalizedReachability(finding, index, diagnostics) {
  const raw = finding.reachability;
  if (raw === undefined) return null;
  if (!isRecord(raw)) {
    diagnostics.push(diagnostic(
      'error',
      'finding.reachability',
      `Finding #${index} reachability must be an object.`,
    ));
    return null;
  }
  let valid = true;
  if (!VALID_REACHABILITY_KIND.has(raw.kind)) {
    diagnostics.push(diagnostic(
      'error',
      'finding.reachability-kind',
      `Finding #${index} has invalid reachability kind ${JSON.stringify(raw.kind)}.`,
    ));
    valid = false;
  }
  for (const field of ['path', 'evidence']) {
    if (typeof raw[field] !== 'string' || raw[field].trim() === '') {
      diagnostics.push(diagnostic(
        'error',
        'finding.reachability-field',
        `Finding #${index} reachability requires non-empty field ${JSON.stringify(field)}.`,
      ));
      valid = false;
    }
  }
  if (!VALID_PREMISE_STATUS.has(raw.status)) {
    diagnostics.push(diagnostic(
      'error',
      'finding.reachability-status',
      `Finding #${index} has invalid reachability status ${JSON.stringify(raw.status)}.`,
    ));
    valid = false;
  }
  return valid ? raw : null;
}

function normalizedIdList(raw, field, label, diagnostics) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string' || value.trim() === '')) {
    diagnostics.push(diagnostic(
      'error',
      `${field}.type`,
      `${label} must be a list of non-empty string ids.`,
    ));
    return [];
  }
  const values = [];
  for (const value of raw) {
    if (values.includes(value)) {
      diagnostics.push(diagnostic('error', `${field}.duplicate`, `${label} contains duplicate id ${JSON.stringify(value)}.`));
    } else values.push(value);
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
  if (
    typeof review.skill_name !== 'string' ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(review.skill_name)
  ) {
    diagnostics.push(diagnostic(
      'error',
      'review.skill-name',
      'review.skill_name must use lowercase kebab-case.',
    ));
  }
  if (!VALID_MODES.has(mode)) {
    diagnostics.push(diagnostic('error', 'review.mode', `mode must be one of ${[...VALID_MODES].sort().join(', ')}.`));
  }
  if (!VALID_DIRECTIONS.has(direction)) {
    diagnostics.push(diagnostic('error', 'review.direction', `direction must be one of ${[...VALID_DIRECTIONS].sort().join(', ')}.`));
  }

  const rawComplexity = isRecord(data.complexity) ? data.complexity : {};
  if (data.complexity !== undefined && !isRecord(data.complexity)) {
    diagnostics.push(diagnostic('error', 'complexity.type', 'complexity must be an object.'));
  }
  let complexityVerdict = Object.hasOwn(rawComplexity, 'verdict')
    ? rawComplexity.verdict
    : null;
  let reducibility = Object.hasOwn(rawComplexity, 'reducibility')
    ? rawComplexity.reducibility
    : null;
  let minimalBehaviorContract = Object.hasOwn(rawComplexity, 'minimal_behavior_contract')
    ? rawComplexity.minimal_behavior_contract
    : [];
  if (complexityVerdict !== null && !VALID_COMPLEXITY_VERDICTS.has(complexityVerdict)) {
    diagnostics.push(diagnostic(
      'error',
      'complexity.verdict',
      `complexity.verdict must be null or one of ${[...VALID_COMPLEXITY_VERDICTS].sort().join(', ')}.`,
    ));
    complexityVerdict = null;
  }
  if (reducibility !== null && !VALID_REDUCIBILITY.has(reducibility)) {
    diagnostics.push(diagnostic(
      'error',
      'complexity.reducibility',
      `complexity.reducibility must be null or one of ${[...VALID_REDUCIBILITY].sort().join(', ')}.`,
    ));
    reducibility = null;
  }
  if (
    !Array.isArray(minimalBehaviorContract) ||
    minimalBehaviorContract.some((value) => typeof value !== 'string' || value.trim() === '')
  ) {
    diagnostics.push(diagnostic(
      'error',
      'complexity.contract',
      'complexity.minimal_behavior_contract must be a list of non-empty strings.',
    ));
    minimalBehaviorContract = [];
  } else if (minimalBehaviorContract.length > 8) {
    diagnostics.push(diagnostic(
      'error',
      'complexity.contract-size',
      'complexity.minimal_behavior_contract may contain at most 8 items.',
    ));
  }
  const complexityAssessed = complexityVerdict !== null;
  if (!complexityAssessed && reducibility !== null) {
    diagnostics.push(diagnostic(
      'error',
      'complexity.verdict-required',
      'A reducibility verdict requires a complexity verdict.',
    ));
  }
  if (complexityAssessed && reducibility === null) {
    diagnostics.push(diagnostic(
      'error',
      'complexity.reducibility-required',
      'An assessed complexity verdict requires reducibility.',
    ));
  }
  if (complexityAssessed && minimalBehaviorContract.length === 0) {
    diagnostics.push(diagnostic(
      'error',
      'complexity.contract-required',
      'An assessed complexity verdict requires a minimal behavior contract.',
    ));
  }
  if ((mode === 'full' || mode === 'release') && !complexityAssessed) {
    diagnostics.push(diagnostic(
      'error',
      'complexity.mode-required',
      `${mode} mode requires a complexity verdict and minimum effective control audit.`,
    ));
  }

  const artifacts = isRecord(data.artifacts) ? data.artifacts : {};
  if (data.artifacts !== undefined && !isRecord(data.artifacts)) {
    diagnostics.push(diagnostic('error', 'artifacts.type', 'artifacts must be an object.'));
  }
  for (const [field, value] of Object.entries(artifacts)) {
    if (ARTIFACT_FIELDS.has(field) && typeof value !== 'boolean') {
      diagnostics.push(diagnostic(
        'error',
        'artifacts.value',
        `artifacts.${field} must be a boolean.`,
      ));
    }
  }
  const evalAuditApplicable = artifacts.eval_audit_applicable === true;
  const evalAuditSignals = [
    'trigger_eval_results',
    'behavior_eval_results',
    'regression_eval_results',
    'eval_case_audit',
    'eval_error_cost_policy',
    'eval_baseline_assessed',
    'eval_variance_assessed',
    'eval_failure_triage',
    'eval_driven_change',
    'eval_change_regressions',
    'eval_known_invalid_oracle',
  ];
  if (!evalAuditApplicable && evalAuditSignals.some((field) => artifacts[field] === true)) {
    diagnostics.push(diagnostic(
      'error',
      'eval-audit.applicability',
      'Eval audit evidence or an eval-driven change requires artifacts.eval_audit_applicable=true.',
    ));
  }
  if (
    (mode === 'full' || mode === 'release') &&
    artifacts.minimum_effective_control_audit !== true
  ) {
    diagnostics.push(diagnostic(
      'error',
      'complexity.audit-required',
      `${mode} mode requires artifacts.minimum_effective_control_audit to be true.`,
    ));
  }

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
    const isRequiredFinding = finding.severity === 'P0' || finding.severity === 'P1';
    const materialPremises = normalizedMaterialPremises(finding, index, diagnostics);
    const reachability = normalizedReachability(finding, index, diagnostics);
    if (
      isRequiredFinding &&
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
        isRequiredFinding ? 'error' : 'warning',
        'finding.owner',
        `Finding #${index} uses non-standard owner ${JSON.stringify(owner)}; expected one of ${[...VALID_OWNERS].sort().join(', ')}.`,
      ));
    }
    let evidence = Object.hasOwn(finding, 'evidence') ? finding.evidence : [];
    let counterevidence = Object.hasOwn(finding, 'counterevidence') ? finding.counterevidence : [];
    if (!Array.isArray(evidence) || evidence.some((value) => typeof value !== 'string' || value.trim() === '')) {
      diagnostics.push(diagnostic('error', 'finding.evidence', `Finding #${index} evidence must be a list of non-empty strings.`));
      evidence = [];
    }
    if (!Array.isArray(counterevidence) || counterevidence.some((value) => typeof value !== 'string' || value.trim() === '')) {
      diagnostics.push(diagnostic('error', 'finding.counterevidence', `Finding #${index} counterevidence must be a list of non-empty strings.`));
      counterevidence = [];
    }
    if (isRequiredFinding) {
      for (const field of [
        'location',
        'problem',
        'affected_scenario',
        'impact',
        'correct_owner',
        'minimal_change',
        'validation',
      ]) {
        if (typeof finding[field] !== 'string' || finding[field].trim() === '') {
          diagnostics.push(diagnostic(
            'error',
            'finding.required-field',
            `Finding #${index} (${finding.severity}) requires non-empty field ${JSON.stringify(field)}.`,
          ));
        }
      }
      if (materialPremises.length === 0) {
        diagnostics.push(diagnostic(
          'error',
          'finding.admission-premises',
          `Finding #${index} (${finding.severity}) requires material premises with direct sources.`,
        ));
      } else if (materialPremises.some((premise) => premise.status !== 'supported')) {
        diagnostics.push(diagnostic(
          'error',
          'finding.admission-premise-support',
          `Finding #${index} (${finding.severity}) has an unsupported or unknown material premise.`,
        ));
      }
      if (!reachability || reachability.status !== 'supported') {
        diagnostics.push(diagnostic(
          'error',
          'finding.admission-reachability',
          `Finding #${index} (${finding.severity}) requires supported entry-gate or execution-path reachability.`,
        ));
      }
      if (evidence.length === 0) {
        diagnostics.push(diagnostic(
          'error',
          'finding.admission-evidence',
          `Finding #${index} (${finding.severity}) requires direct evidence.`,
        ));
      }
      if (counterevidence.length === 0) {
        diagnostics.push(diagnostic(
          'error',
          'finding.admission-counterevidence',
          `Finding #${index} (${finding.severity}) requires checked counterevidence.`,
        ));
      }
    }
    const normalized = {
      ...finding,
      id: findingId,
      evidence_types: evidenceTypes,
      material_premises: materialPremises,
      reachability,
      evidence,
      counterevidence,
    };
    delete normalized.evidence_type;
    findings.push(normalized);
  }
  const findingById = new Map(findings.map((finding) => [finding.id, finding]));

  const rawUnknowns = Array.isArray(data.unknowns) ? data.unknowns : [];
  if (data.unknowns !== undefined && !Array.isArray(data.unknowns)) {
    diagnostics.push(diagnostic('error', 'unknowns.type', 'unknowns must be a list.'));
  }
  const unknowns = [];
  const unknownIds = new Set();
  for (let offset = 0; offset < rawUnknowns.length; offset += 1) {
    const index = offset + 1;
    const unknown = rawUnknowns[offset];
    if (!isRecord(unknown)) {
      diagnostics.push(diagnostic('error', 'unknown.item', `Unknown #${index} must be an object.`));
      continue;
    }
    let unknownId = Object.hasOwn(unknown, 'id') ? unknown.id : `unknown-${index}`;
    if (typeof unknownId !== 'string' || unknownId.trim() === '') {
      diagnostics.push(diagnostic('error', 'unknown.id', `Unknown #${index} must have a non-empty id.`));
      unknownId = `unknown-${index}`;
    }
    if (unknownIds.has(unknownId)) {
      diagnostics.push(diagnostic('error', 'unknown.duplicate', `Duplicate unknown id: ${unknownId}.`));
    }
    unknownIds.add(unknownId);
    if (!Object.hasOwn(DIMENSIONS, unknown.dimension)) {
      diagnostics.push(diagnostic('error', 'unknown.dimension', `Unknown #${index} has invalid dimension ${JSON.stringify(unknown.dimension)}.`));
    }
    for (const field of ['description', 'required_evidence']) {
      if (typeof unknown[field] !== 'string' || unknown[field].trim() === '') {
        diagnostics.push(diagnostic('error', 'unknown.required-field', `Unknown #${index} requires non-empty field ${JSON.stringify(field)}.`));
      }
    }
    unknowns.push({ ...unknown, id: unknownId });
  }
  const unknownById = new Map(unknowns.map((unknown) => [unknown.id, unknown]));

  const rawDimensions = Array.isArray(data.dimensions) ? data.dimensions : [];
  if (!Array.isArray(data.dimensions)) {
    diagnostics.push(diagnostic('error', 'dimensions.type', 'dimensions must be a list.'));
  }
  const seen = new Set();
  const scoredRows = [];
  let assessedWeight = 0;
  let weightedPoints = 0;
  let confidencePoints = 0;
  const findingAssignments = new Map();
  const unknownAssignments = new Map();

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
    const dimensionFindingIds = normalizedIdList(
      item.finding_ids,
      'dimension.finding-ids',
      `finding_ids for ${dimensionId}`,
      diagnostics,
    );
    const dimensionUnknownIds = normalizedIdList(
      item.unknown_ids,
      'dimension.unknown-ids',
      `unknown_ids for ${dimensionId}`,
      diagnostics,
    );
    let summary = Object.hasOwn(item, 'summary') ? item.summary : '';

    if (!Object.hasOwn(CONFIDENCE_VALUES, confidence)) {
      diagnostics.push(diagnostic('error', 'dimension.confidence', `Invalid confidence for ${dimensionId}: ${JSON.stringify(confidence)}.`));
      confidence = 'unknown';
    }
    if (
      !Array.isArray(evidence) ||
      evidence.some((value) => typeof value !== 'string' || value.trim() === '')
    ) {
      diagnostics.push(diagnostic('error', 'dimension.evidence', `evidence for ${dimensionId} must be a list of non-empty strings.`));
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

    for (const findingId of dimensionFindingIds) {
      const finding = findingById.get(findingId);
      if (!finding) {
        diagnostics.push(diagnostic('error', 'dimension.finding-reference', `${dimensionId} references unknown finding ${JSON.stringify(findingId)}.`));
        continue;
      }
      if (finding.dimension !== dimensionId) {
        diagnostics.push(diagnostic(
          'error',
          'dimension.finding-dimension',
          `${dimensionId} references finding ${JSON.stringify(findingId)} whose primary dimension is ${JSON.stringify(finding.dimension)}.`,
        ));
      }
      const assignments = findingAssignments.get(findingId) ?? new Set();
      assignments.add(dimensionId);
      findingAssignments.set(findingId, assignments);
    }
    for (const unknownId of dimensionUnknownIds) {
      const unknown = unknownById.get(unknownId);
      if (!unknown) {
        diagnostics.push(diagnostic('error', 'dimension.unknown-reference', `${dimensionId} references unknown evidence gap ${JSON.stringify(unknownId)}.`));
        continue;
      }
      if (unknown.dimension !== dimensionId) {
        diagnostics.push(diagnostic(
          'error',
          'dimension.unknown-dimension',
          `${dimensionId} references unknown ${JSON.stringify(unknownId)} whose primary dimension is ${JSON.stringify(unknown.dimension)}.`,
        ));
      }
      const assignments = unknownAssignments.get(unknownId) ?? new Set();
      assignments.add(dimensionId);
      unknownAssignments.set(unknownId, assignments);
    }
    if (
      score !== null && score < 5 &&
      dimensionFindingIds.length === 0 && dimensionUnknownIds.length === 0
    ) {
      diagnostics.push(diagnostic(
        'error',
        'dimension.untraceable-score',
        `${dimensionId} has score ${score} below 5 but no finding_ids or unknown_ids.`,
      ));
    }

    let weighted = null;
    if (score !== null) {
      assessedWeight += weight;
      weighted = weight * score / 5;
      weightedPoints += weighted;
      confidencePoints += weight * CONFIDENCE_VALUES[confidence];
      if (evidence.length === 0) {
        diagnostics.push(diagnostic('error', 'dimension.no-evidence', `${dimensionId} has a score but no evidence location.`));
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
      finding_ids: dimensionFindingIds,
      unknown_ids: dimensionUnknownIds,
      summary,
    });
  }

  const missingDimensions = Object.keys(DIMENSIONS).filter((id) => !seen.has(id)).sort();
  if (missingDimensions.length > 0) {
    diagnostics.push(diagnostic('error', 'dimension.missing', `Missing dimensions: ${missingDimensions.join(', ')}`));
  }

  const scoredCount = scoredRows.filter((row) => row.score !== null).length;
  if (mode === 'quick') {
    if (scoredCount > 5) {
      diagnostics.push(diagnostic('error', 'mode.quick-scope', `Quick mode may score at most 5 dimensions; received ${scoredCount}.`));
    } else if (scoredCount < 3) {
      diagnostics.push(diagnostic('warning', 'mode.quick-scope', `Quick mode normally scores 3-5 dimensions; received ${scoredCount}.`));
    }
  }
  if (mode === 'delta' && scoredCount === 0) {
    diagnostics.push(diagnostic('error', 'mode.delta-scope', 'Delta mode must score at least one affected dimension.'));
  }
  if (mode === 'full' || mode === 'release') {
    const unscored = scoredRows.filter((row) => row.score === null).map((row) => row.id);
    if (unscored.length > 0) {
      diagnostics.push(diagnostic(
        'error',
        'dimension.mode-required',
        `${mode} mode requires scores for all 12 dimensions; missing: ${unscored.join(', ')}.`,
      ));
    }
  }

  for (const finding of findings) {
    const assignments = findingAssignments.get(finding.id);
    if (!assignments || assignments.size === 0) {
      diagnostics.push(diagnostic('error', 'finding.unassigned', `Finding ${JSON.stringify(finding.id)} is not linked from its primary dimension.`));
    } else if (assignments.size > 1) {
      diagnostics.push(diagnostic('error', 'finding.multiple-dimensions', `Finding ${JSON.stringify(finding.id)} is linked from multiple dimensions.`));
    }
  }
  for (const unknown of unknowns) {
    const assignments = unknownAssignments.get(unknown.id);
    if (!assignments || assignments.size === 0) {
      diagnostics.push(diagnostic('error', 'unknown.unassigned', `Unknown ${JSON.stringify(unknown.id)} is not linked from its primary dimension.`));
    } else if (assignments.size > 1) {
      diagnostics.push(diagnostic('error', 'unknown.multiple-dimensions', `Unknown ${JSON.stringify(unknown.id)} is linked from multiple dimensions.`));
    }
  }

  const coverage = assessedWeight;
  const aggregateEligible = (
    (mode === 'full' || mode === 'release') && assessedWeight === 100
  );
  const totalScore = aggregateEligible ? weightedPoints / assessedWeight * 100 : null;
  const confidenceIndex = assessedWeight > 0
    ? confidencePoints / assessedWeight
    : null;
  const normalizedScore = totalScore === null ? null : roundPythonFloat(totalScore, 1);
  const normalizedConfidenceIndex = confidenceIndex === null
    ? null
    : roundPythonFloat(confidenceIndex, 2);
  const overallConfidence = confidenceLabel(normalizedConfidenceIndex, coverage);
  const rowById = Object.fromEntries(scoredRows.map((row) => [row.id, row]));
  const minimumControl = rowById.minimum_control;
  if (minimumControl?.score !== null && minimumControl?.score !== undefined && !complexityAssessed) {
    diagnostics.push(diagnostic(
      'error',
      'complexity.verdict-required',
      'A scored minimum_control dimension requires a complexity verdict.',
    ));
  }
  if (complexityAssessed && (minimumControl?.score === null || minimumControl?.score === undefined)) {
    diagnostics.push(diagnostic(
      'error',
      'complexity.dimension-required',
      'An assessed complexity verdict requires a scored minimum_control dimension.',
    ));
  }
  if (
    (complexityVerdict === 'minimal' || complexityVerdict === 'proportionate') &&
    minimumControl?.score !== null &&
    minimumControl?.score !== undefined &&
    minimumControl.score <= 3
  ) {
    diagnostics.push(diagnostic(
      'error',
      'complexity.score',
      `${complexityVerdict} requires minimum_control score above 3.`,
    ));
  }
  if (complexityVerdict === 'over-specified') {
    if (direction === 'aligned') {
      diagnostics.push(diagnostic(
        'error',
        'complexity.direction',
        'An over-specified Skill cannot use aligned direction.',
      ));
    }
    if ((minimumControl?.finding_ids ?? []).length === 0) {
      diagnostics.push(diagnostic(
        'error',
        'complexity.finding-required',
        'An over-specified verdict must reference a minimum_control finding.',
      ));
    }
    if (minimumControl?.score !== null && minimumControl?.score > 3) {
      diagnostics.push(diagnostic(
        'error',
        'complexity.score',
        'An over-specified verdict requires minimum_control score 3 or lower.',
      ));
    }
    if (reducibility === 'almost-none' || reducibility === 'minor') {
      diagnostics.push(diagnostic(
        'error',
        'complexity.reducibility-mismatch',
        'An over-specified verdict requires significant or larger reducibility.',
      ));
    }
  }
  if (complexityVerdict === 'over-engineered') {
    if (direction !== 'drifted') {
      diagnostics.push(diagnostic(
        'error',
        'complexity.direction',
        'An over-engineered Skill must use drifted direction.',
      ));
    }
    if ((minimumControl?.finding_ids ?? []).length === 0) {
      diagnostics.push(diagnostic(
        'error',
        'complexity.finding-required',
        'An over-engineered verdict must reference a minimum_control finding.',
      ));
    }
    if (minimumControl?.score !== null && minimumControl?.score > 2) {
      diagnostics.push(diagnostic(
        'error',
        'complexity.score',
        'An over-engineered verdict requires minimum_control score 2 or lower.',
      ));
    }
    if (reducibility === 'almost-none' || reducibility === 'minor') {
      diagnostics.push(diagnostic(
        'error',
        'complexity.reducibility-mismatch',
        'An over-engineered verdict requires significant or larger reducibility.',
      ));
    }
  }
  const capWarning = (dimensionId, maximum, condition, code, message) => {
    const score = rowById[dimensionId]?.score;
    if (score !== null && score !== undefined && score > maximum && !condition) {
      diagnostics.push(diagnostic('warning', code, message));
    }
  };
  capWarning(
    'triggering',
    3,
    artifacts.trigger_eval_results === true,
    'cap.triggering-eval',
    'Triggering score exceeds 3 without trigger eval results; explain or lower the score.',
  );
  capWarning(
    'triggering',
    4,
    artifacts.pointer_audit === true,
    'cap.triggering-pointer',
    'Triggering score exceeds 4 without an invocation/pointer audit.',
  );
  capWarning(
    'instruction_design',
    4,
    artifacts.completion_boundary_audit === true,
    'cap.completion-boundary',
    'Instruction-design score exceeds 4 without a completion-boundary audit.',
  );
  capWarning(
    'minimum_control',
    3,
    artifacts.minimum_effective_control_audit === true || mode === 'full' || mode === 'release',
    'cap.minimum-control',
    'Minimum-control score exceeds 3 without a minimum-effective-control audit.',
  );
  capWarning(
    'context_disclosure',
    4,
    artifacts.information_hierarchy_map === true,
    'cap.information-hierarchy',
    'Context/disclosure score exceeds 4 without an information-hierarchy map.',
  );
  if (evalAuditApplicable) {
    const evalExecutionEvidence = [
      artifacts.trigger_eval_results,
      artifacts.behavior_eval_results,
      artifacts.regression_eval_results,
      artifacts.runtime_traces,
    ].some((value) => value === true);
    if (artifacts.eval_known_invalid_oracle === true && artifacts.eval_driven_change === true) {
      capWarning(
        'evals',
        1,
        false,
        'cap.evals-invalid-oracle',
        'Evals score exceeds 1 although a known invalid oracle drives the current change.',
      );
    } else if (artifacts.eval_case_audit !== true) {
      capWarning(
        'evals',
        2,
        false,
        'cap.evals-case-audit',
        'Evals score exceeds 2 without a Case Admission Audit.',
      );
    } else if (!evalExecutionEvidence) {
      capWarning(
        'evals',
        3,
        false,
        'cap.evals-execution',
        'Evals score exceeds 3 without executed eval or runtime trace evidence.',
      );
    } else {
      const resultDecisionComplete = [
        artifacts.eval_error_cost_policy,
        artifacts.eval_baseline_assessed,
        artifacts.eval_variance_assessed,
        artifacts.eval_failure_triage,
      ].every((value) => value === true);
      capWarning(
        'evals',
        4,
        resultDecisionComplete,
        'cap.evals-result-decision',
        'Evals score exceeds 4 without error-cost policy, baseline assessment, variance analysis, and failure triage.',
      );
    }
  }
  if (artifacts.scripts_present === true) {
    capWarning(
      'scripts',
      3,
      artifacts.scripts_checked === true,
      'cap.scripts',
      'Scripts score exceeds 3 although scripts were not checked.',
    );
  }
  if (artifacts.compatibility_claims === true) {
    capWarning(
      'reliability',
      3,
      artifacts.compatibility_verified === true,
      'cap.reliability',
      'Reliability score exceeds 3 with unverified compatibility claims.',
    );
  }
  if (mode === 'delta') {
    capWarning(
      'maintainability',
      3,
      artifacts.previous_version === true,
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
    const gateFindingIds = normalizedIdList(
      gate.finding_ids,
      'gate.finding-ids',
      `finding_ids for gate ${JSON.stringify(gateId)}`,
      diagnostics,
    );
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
    const requiredSeverity = REQUIRED_GATES.get(gateId);
    if (requiredSeverity && severity !== requiredSeverity) {
      diagnostics.push(diagnostic('error', 'gate.required-severity', `Gate ${gateId} must use severity ${requiredSeverity}.`));
    }
    if (typeof reason !== 'string') {
      diagnostics.push(diagnostic('error', 'gate.reason', `Reason for ${gateId} must be a string.`));
      reason = '';
    }
    if (status === 'fail' && reason.trim() === '') {
      diagnostics.push(diagnostic('error', 'gate.no-reason', `Gate ${gateId} is fail but has no reason.`));
    } else if (status === 'unknown' && reason.trim() === '') {
      diagnostics.push(diagnostic('warning', 'gate.no-reason', `Gate ${gateId} is unknown but has no reason.`));
    }
    if (status === 'fail') {
      if (gateFindingIds.length === 0) {
        diagnostics.push(diagnostic('error', 'gate.finding-required', `Failed gate ${gateId} must reference an admitted finding.`));
      }
      for (const findingId of gateFindingIds) {
        const finding = findingById.get(findingId);
        if (!finding) {
          diagnostics.push(diagnostic('error', 'gate.finding-reference', `Gate ${gateId} references unknown finding ${JSON.stringify(findingId)}.`));
        } else if (finding.severity !== severity) {
          diagnostics.push(diagnostic(
            'error',
            'gate.finding-severity',
            `Gate ${gateId} severity ${severity} does not match finding ${JSON.stringify(findingId)} severity ${finding.severity}.`,
          ));
        }
      }
    } else if (gateFindingIds.length > 0) {
      diagnostics.push(diagnostic('error', 'gate.unexpected-findings', `Gate ${gateId} may reference findings only when status is fail.`));
    }
    if (mode === 'release' && gateId === 'release-evidence' && status === 'not_applicable') {
      diagnostics.push(diagnostic('error', 'gate.release-evidence-required', 'release-evidence cannot be not_applicable in release mode.'));
    }
    gates.push({ id: gateId, status, severity, finding_ids: gateFindingIds, reason });
  }
  const missingGates = [...REQUIRED_GATES.keys()].filter((id) => !gateIds.has(id)).sort();
  if (missingGates.length > 0) diagnostics.push(diagnostic('error', 'gate.missing', `Missing required gates: ${missingGates.join(', ')}`));

  const gateById = new Map(gates.map((gate) => [gate.id, gate]));
  const evalValidity = gateById.get('eval-validity');
  const evalChangeSafety = gateById.get('eval-change-safety');
  if (evalValidity) {
    if (evalAuditApplicable && evalValidity.status === 'not_applicable') {
      diagnostics.push(diagnostic(
        'error',
        'gate.eval-validity-applicable',
        'eval-validity cannot be not_applicable when eval evidence is in review scope.',
      ));
    }
    if (!evalAuditApplicable && evalValidity.status !== 'not_applicable') {
      diagnostics.push(diagnostic(
        'error',
        'gate.eval-validity-not-applicable',
        'eval-validity must be not_applicable when no eval evidence is in review scope.',
      ));
    }
    if (
      evalValidity.status === 'pass' &&
      (
        artifacts.eval_case_audit !== true ||
        artifacts.eval_error_cost_policy !== true ||
        artifacts.eval_known_invalid_oracle === true
      )
    ) {
      diagnostics.push(diagnostic(
        'error',
        'gate.eval-validity-evidence',
        'eval-validity pass requires a completed Case Admission Audit, an error-cost policy, and no known invalid oracle.',
      ));
    }
    if (artifacts.eval_known_invalid_oracle === true && evalValidity.status !== 'fail') {
      diagnostics.push(diagnostic(
        'error',
        'gate.eval-validity-known-invalid',
        'A known invalid oracle requires eval-validity=fail.',
      ));
    }
  }
  const evalDrivenChange = artifacts.eval_driven_change === true;
  if (evalChangeSafety) {
    if (evalDrivenChange && evalChangeSafety.status === 'not_applicable') {
      diagnostics.push(diagnostic(
        'error',
        'gate.eval-change-safety-applicable',
        'eval-change-safety cannot be not_applicable for an eval-driven change.',
      ));
    }
    if (!evalDrivenChange && evalChangeSafety.status !== 'not_applicable') {
      diagnostics.push(diagnostic(
        'error',
        'gate.eval-change-safety-not-applicable',
        'eval-change-safety must be not_applicable when no eval-driven change is in review scope.',
      ));
    }
    if (
      evalChangeSafety.status === 'pass' &&
      (
        evalValidity?.status !== 'pass' ||
        artifacts.eval_failure_triage !== true ||
        artifacts.eval_change_regressions !== true
      )
    ) {
      diagnostics.push(diagnostic(
        'error',
        'gate.eval-change-safety-evidence',
        'eval-change-safety pass requires eval-validity pass, failure triage, and change regression evidence.',
      ));
    }
  }

  const hasP0Gate = gates.some((gate) => gate.status === 'fail' && gate.severity === 'P0');
  const hasP1Gate = gates.some((gate) => gate.status === 'fail' && gate.severity === 'P1');
  const hasP0Finding = findings.some((finding) => finding.severity === 'P0');
  const hasP1Finding = findings.some((finding) => finding.severity === 'P1');
  const criticalUnknown = gates.some((gate) => gate.status === 'unknown' && REQUIRED_GATES.has(gate.id));
  const rawQualityBand = qualityBand(normalizedScore);
  const effectiveBand = effectiveQualityBand(rawQualityBand, complexityVerdict);
  let release;
  if (hasP0Gate || hasP0Finding) release = 'fail';
  else if (hasP1Gate || hasP1Finding) release = 'pass-after-fixes';
  else if (mode === 'quick') release = 'provisional';
  else if (mode === 'delta' && (scoredCount === 0 || artifacts.previous_version !== true)) release = 'provisional';
  else if (criticalUnknown) release = 'provisional';
  else if (complexityVerdict === 'over-specified' || complexityVerdict === 'over-engineered') release = 'provisional';
  else if (
    (mode === 'full' || mode === 'release') &&
    (coverage < 100 || overallConfidence === 'low')
  ) release = 'provisional';
  else if (mode === 'release' && artifacts.current_sources_checked !== true) release = 'provisional';
  else release = 'pass';

  const errorCount = diagnostics.filter((entry) => entry.level === 'error').length;
  return {
    review,
    complexity: {
      verdict: complexityVerdict,
      reducibility,
      minimal_behavior_contract: minimalBehaviorContract,
    },
    score: {
      weighted_score: normalizedScore,
      coverage_percent: coverage,
      confidence_index: normalizedConfidenceIndex,
      confidence: overallConfidence,
      quality_band: rawQualityBand,
      effective_quality_band: effectiveBand,
      quality_cap_reason: effectiveBand !== rawQualityBand ? complexityVerdict : null,
      release,
    },
    dimensions: scoredRows,
    gates,
    unknowns,
    findings,
    diagnostics,
    valid: errorCount === 0,
  };
}

function renderText(result) {
  const score = result.score;
  const scoreText = score.weighted_score === null
    ? 'not calculated'
    : `${score.weighted_score} / 100 (${score.quality_band})`;
  const lines = [
    `Skill: ${result.review.skill_name ?? ''}`,
    `Mode / direction: ${result.review.mode ?? ''} / ${result.review.direction ?? ''}`,
    `Complexity: ${result.complexity.verdict ?? 'not assessed'} / ${result.complexity.reducibility ?? 'not assessed'}`,
    `Score: ${scoreText}`,
    `Effective quality: ${score.effective_quality_band ?? 'not calculated'}`,
    `Coverage: ${score.coverage_percent}%`,
    `Confidence: ${score.confidence} (${score.confidence_index})`,
    `Release: ${score.release}`,
    `Ledger: ${result.findings.length} findings, ${result.unknowns.length} unknowns`,
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

const isMain = process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) await main();

export { validateAndCalculate };
