#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const VALID_TYPES = new Set(['trigger', 'gate', 'routing', 'behavior', 'outcome', 'cost']);
const VALID_SPLITS = new Set(['train', 'validation', 'sanity']);
const VALID_ROLES = new Set(['representative', 'regression', 'boundary', 'challenge', 'diagnostic']);
const VALID_PROVENANCE = new Set([
  'observed',
  'derived',
  'representative-synthetic',
  'boundary',
  'challenge',
  'mechanism-probe',
]);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);
const VALID_OPTIMIZATION = new Set(['recall-first', 'precision-first', 'balanced', 'critical']);
const VALID_COST = new Set(['low', 'medium', 'high', 'critical']);
const RELEASE_RELEVANT_ROLES = new Set(['representative', 'regression', 'boundary']);
const RELEASE_RELEVANT_SPLITS = new Set(['train', 'validation', 'sanity']);
const TRIGGER_KEYS = new Set([
  'expected_first_loaded_skill',
  'load_skill',
  'should_load_skill',
  'triggered',
  'should_trigger',
]);
const NON_TRIGGER_HINTS = new Set([
  'spawn_agent',
  'should_spawn_agent',
  'gate',
  'agent_type',
  'model',
  'reasoning_effort',
  'final_output',
  'outcome',
]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function diagnostic(level, code, message, caseId = null) {
  return { level, code, message, case_id: caseId };
}

function enumDiagnosticLevel(value, admissionLevel) {
  return value === undefined ? admissionLevel : 'error';
}

function parseArgs(argv) {
  let input;
  let format = 'text';
  let strict = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--strict') strict = true;
    else if (arg === '--format') {
      format = argv[++index];
      if (!format) throw new Error('--format requires a value.');
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!input) input = path.resolve(arg);
    else throw new Error('Only one eval case file may be supplied.');
  }
  if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json.');
  if (!help && !input) {
    throw new Error('Usage: validate-eval-cases.mjs <eval-cases.json> [--strict] [--format text|json]');
  }
  return { input, format, strict, help };
}

function loadCases(data) {
  if (Array.isArray(data)) return { metadata: null, cases: data, container: 'array' };
  if (!isRecord(data)) throw new Error('Top level must be an array or object.');
  for (const key of ['evals', 'cases']) {
    if (Array.isArray(data[key])) return { metadata: data, cases: data[key], container: key };
  }
  throw new Error('Object must contain an evals or cases array.');
}

function validatePolicy(metadata, diagnostics, strict) {
  if (!metadata) return;
  const admissionLevel = strict ? 'error' : 'warning';
  if (metadata.policy === undefined) {
    diagnostics.push(diagnostic(
      admissionLevel,
      'suite.missing-policy',
      'Suite wrapper has no policy object; false-negative and false-positive costs are undefined.',
    ));
    return;
  }
  if (!isRecord(metadata.policy)) {
    diagnostics.push(diagnostic(
      'error',
      'suite.policy-type',
      'policy must be an object.',
    ));
    return;
  }
  const policy = metadata.policy;
  if (!VALID_OPTIMIZATION.has(policy.optimization)) {
    diagnostics.push(diagnostic(
      enumDiagnosticLevel(policy.optimization, admissionLevel),
      'suite.policy-optimization',
      `policy.optimization must be one of ${[...VALID_OPTIMIZATION].sort().join(', ')}.`,
    ));
  }
  for (const field of ['false_negative_cost', 'false_positive_cost']) {
    if (!VALID_COST.has(policy[field])) {
      diagnostics.push(diagnostic(
        enumDiagnosticLevel(policy[field], admissionLevel),
        `suite.policy-${field.replaceAll('_', '-')}`,
        `policy.${field} must be one of ${[...VALID_COST].sort().join(', ')}.`,
      ));
    }
  }
  if (!hasText(policy.rationale)) {
    diagnostics.push(diagnostic(
      admissionLevel,
      'suite.policy-rationale',
      'policy.rationale must explain the selected error costs.',
    ));
  }
}

function hasObservableAssertion(evalCase) {
  if (Array.isArray(evalCase.assertions) && evalCase.assertions.length > 0) return true;
  if (isRecord(evalCase.expected) && Object.keys(evalCase.expected).length > 0) return true;
  if (typeof evalCase.should_load_skill === 'boolean') return true;
  if (Array.isArray(evalCase.expected_loaded_skills)) return true;
  if (hasText(evalCase.expected_first_loaded_skill)) return true;
  if (hasText(evalCase.expected_output)) return true;
  if (isRecord(evalCase.review)) {
    if (Array.isArray(evalCase.review.checks) && evalCase.review.checks.length > 0) return true;
    if (Array.isArray(evalCase.review.artifacts) && evalCase.review.artifacts.length > 0) return true;
  }
  return false;
}

function validateAssertions(evalCase, caseId, diagnostics, strict, releaseRelevant) {
  const admissionLevel = strict && releaseRelevant ? 'error' : 'warning';
  if (!hasObservableAssertion(evalCase) && releaseRelevant) {
    diagnostics.push(diagnostic(
      admissionLevel,
      'case.observable-assertion',
      'Release-relevant case has no observable expected result or assertion.',
      caseId,
    ));
  }
  if (evalCase.assertions === undefined) return;
  if (!Array.isArray(evalCase.assertions)) {
    diagnostics.push(diagnostic('error', 'case.assertions-type', 'assertions must be an array.', caseId));
    return;
  }
  for (const [index, assertion] of evalCase.assertions.entries()) {
    if (!isRecord(assertion)) {
      diagnostics.push(diagnostic('error', 'case.assertion-type', `Assertion #${index} must be an object.`, caseId));
      continue;
    }
    if (!hasText(assertion.text)) {
      diagnostics.push(diagnostic(admissionLevel, 'case.assertion-text', `Assertion #${index} has no text.`, caseId));
    }
    if (!hasText(assertion.grader)) {
      diagnostics.push(diagnostic(admissionLevel, 'case.assertion-grader', `Assertion #${index} has no grader.`, caseId));
    }
    if (!hasText(assertion.allowed_variance)) {
      diagnostics.push(diagnostic(
        admissionLevel,
        'case.assertion-variance',
        `Assertion #${index} does not define allowed_variance.`,
        caseId,
      ));
    }
  }
}

function validateTriggerLayer(evalCase, caseId, diagnostics) {
  if (evalCase.eval_type !== 'trigger' && Object.hasOwn(evalCase, 'expected_loaded_skills')) {
    diagnostics.push(diagnostic(
      'error',
      'case.route-expectation-type',
      'expected_loaded_skills is only valid for trigger cases.',
      caseId,
    ));
  }
  if (evalCase.eval_type !== 'trigger' && Object.hasOwn(evalCase, 'expected_first_loaded_skill')) {
    diagnostics.push(diagnostic(
      'error',
      'case.route-expectation-type',
      'expected_first_loaded_skill is only valid for trigger cases.',
      caseId,
    ));
  }
  if (evalCase.eval_type !== 'trigger') return;
  if (Object.hasOwn(evalCase, 'expected_first_loaded_skill') && !hasText(evalCase.expected_first_loaded_skill)) {
    diagnostics.push(diagnostic(
      'error',
      'case.first-route-expectation-type',
      'expected_first_loaded_skill must be a non-empty string.',
      caseId,
    ));
  }
  const topLevelSuspicious = [...NON_TRIGGER_HINTS].filter((key) => Object.hasOwn(evalCase, key));
  if (topLevelSuspicious.length > 0) {
    diagnostics.push(diagnostic(
      'error',
      'case.layer-mixing',
      `Trigger case contains non-trigger expectations: ${topLevelSuspicious.sort().join(', ')}.`,
      caseId,
    ));
  }
  if (!isRecord(evalCase.expected)) return;
  const keys = Object.keys(evalCase.expected);
  const suspicious = keys.filter((key) => NON_TRIGGER_HINTS.has(key));
  if (suspicious.length > 0) {
    diagnostics.push(diagnostic(
      'error',
      'case.layer-mixing',
      `Trigger expected object contains non-trigger expectations: ${suspicious.sort().join(', ')}.`,
      caseId,
    ));
  }
  const extra = keys.filter((key) => !TRIGGER_KEYS.has(key) && !NON_TRIGGER_HINTS.has(key));
  if (extra.length > 0) {
    diagnostics.push(diagnostic(
      'warning',
      'case.trigger-extra-keys',
      `Trigger expected object has extra keys; verify layer separation: ${extra.sort().join(', ')}.`,
      caseId,
    ));
  }
}

function validateCase(evalCase, index, state) {
  const { diagnostics, seen, families, roleCounts, typeCounts, strict, container, metadata } = state;
  if (!isRecord(evalCase)) {
    diagnostics.push(diagnostic('error', 'case.type', `Case #${index} must be an object.`));
    return;
  }
  const caseId = hasText(evalCase.id) ? evalCase.id.trim() : `#${index}`;
  if (!hasText(evalCase.id)) {
    diagnostics.push(diagnostic('error', 'case.id', 'Case requires a non-empty id.', caseId));
  }
  if (seen.has(caseId)) diagnostics.push(diagnostic('error', 'case.duplicate-id', 'Duplicate case id.', caseId));
  seen.add(caseId);

  const evalType = evalCase.eval_type;
  const split = evalCase.split;
  const role = evalCase.case_role;
  const provenance = evalCase.provenance;
  const family = evalCase.scenario_family;
  const executableConversationCase = (
    container === 'evals' &&
    hasText(metadata?.skill_name) &&
    (hasText(evalCase.prompt) || hasText(evalCase.expected_output) || isRecord(evalCase.review))
  );
  const releaseRelevant = (
    RELEASE_RELEVANT_ROLES.has(role) ||
    RELEASE_RELEVANT_SPLITS.has(split) ||
    executableConversationCase
  );
  const admissionLevel = strict && releaseRelevant ? 'error' : 'warning';

  if (!VALID_TYPES.has(evalType)) {
    diagnostics.push(diagnostic(
      enumDiagnosticLevel(evalType, strict ? 'error' : 'warning'),
      'case.eval-type',
      `Missing or invalid eval_type; allowed: ${[...VALID_TYPES].sort().join(', ')}.`,
      caseId,
    ));
  } else typeCounts.set(evalType, (typeCounts.get(evalType) ?? 0) + 1);

  if (split !== undefined && !VALID_SPLITS.has(split)) {
    diagnostics.push(diagnostic(
      'error',
      'case.split',
      `Invalid split for the current repository contract; allowed: ${[...VALID_SPLITS].sort().join(', ')}.`,
      caseId,
    ));
  }
  if (!VALID_ROLES.has(role)) {
    diagnostics.push(diagnostic(
      enumDiagnosticLevel(role, strict ? 'error' : 'warning'),
      'case.role',
      `Missing or invalid case_role; allowed: ${[...VALID_ROLES].sort().join(', ')}.`,
      caseId,
    ));
  } else roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);

  if (!VALID_PROVENANCE.has(provenance)) {
    diagnostics.push(diagnostic(
      enumDiagnosticLevel(provenance, strict ? 'error' : 'warning'),
      'case.provenance',
      `Missing or invalid provenance; allowed: ${[...VALID_PROVENANCE].sort().join(', ')}.`,
      caseId,
    ));
  }
  if (!hasText(family)) {
    diagnostics.push(diagnostic(strict ? 'error' : 'warning', 'case.scenario-family', 'Missing scenario_family.', caseId));
  } else families.add(family.trim());

  if (releaseRelevant && !hasText(evalCase.unit_under_test)) {
    diagnostics.push(diagnostic(admissionLevel, 'case.unit-under-test', 'Missing unit_under_test.', caseId));
  }
  if (releaseRelevant && !isRecord(evalCase.preconditions)) {
    diagnostics.push(diagnostic(admissionLevel, 'case.preconditions', 'Release-relevant case requires preconditions object.', caseId));
  }

  const oracle = evalCase.oracle;
  if (releaseRelevant) {
    if (!isRecord(oracle)) {
      diagnostics.push(diagnostic(admissionLevel, 'oracle.missing', 'Release-relevant case requires oracle object.', caseId));
    } else {
      if (!hasText(oracle.rationale)) {
        diagnostics.push(diagnostic(admissionLevel, 'oracle.rationale', 'Missing oracle rationale.', caseId));
      }
      if (!Array.isArray(oracle.rule_refs) || !oracle.rule_refs.some(hasText)) {
        diagnostics.push(diagnostic(admissionLevel, 'oracle.rule-refs', 'Missing non-empty oracle rule_refs.', caseId));
      }
      if (!VALID_CONFIDENCE.has(oracle.confidence)) {
        diagnostics.push(diagnostic(
          enumDiagnosticLevel(oracle.confidence, admissionLevel),
          'oracle.confidence',
          'Missing or invalid oracle confidence.',
          caseId,
        ));
      }
      if (!hasText(oracle.allowed_variance)) {
        diagnostics.push(diagnostic(admissionLevel, 'oracle.allowed-variance', 'Missing oracle allowed_variance.', caseId));
      }
    }
  }
  if (role === 'boundary' || role === 'regression') {
    if (!isRecord(oracle) || !hasText(oracle.minimal_counterexample)) {
      diagnostics.push(diagnostic(
        admissionLevel,
        'oracle.minimal-counterexample',
        'Boundary or regression case requires a minimal_counterexample.',
        caseId,
      ));
    }
  }

  validateAssertions(evalCase, caseId, diagnostics, strict, releaseRelevant);
  validateTriggerLayer(evalCase, caseId, diagnostics);

  if ((role === 'challenge' || role === 'diagnostic') && split === 'train') {
    diagnostics.push(diagnostic(
      'warning',
      'case.role-split-conflict',
      `${role} case is in train; verify it must influence optimization.`,
      caseId,
    ));
  }

  if (isRecord(evalCase.run_policy)) {
    const initialRuns = evalCase.run_policy.initial_runs;
    if (Number.isInteger(initialRuns) && initialRuns < 3) {
      diagnostics.push(diagnostic('warning', 'run-policy.initial-runs', 'initial_runs is below 3.', caseId));
    }
  }
}

function validate(data, sourcePath, strict) {
  const { metadata, cases, container } = loadCases(data);
  const diagnostics = [];
  validatePolicy(metadata, diagnostics, strict);
  const state = {
    diagnostics,
    seen: new Set(),
    families: new Set(),
    roleCounts: new Map(),
    typeCounts: new Map(),
    strict,
    container,
    metadata,
  };
  cases.forEach((evalCase, index) => validateCase(evalCase, index, state));
  const errors = diagnostics.filter((entry) => entry.level === 'error');
  const warnings = diagnostics.filter((entry) => entry.level === 'warning');
  return {
    path: sourcePath,
    mode: strict ? 'strict' : 'compatible',
    container,
    summary: {
      cases: cases.length,
      scenario_families: state.families.size,
      type_counts: Object.fromEntries(state.typeCounts),
      role_counts: Object.fromEntries(state.roleCounts),
      errors: errors.length,
      warnings: warnings.length,
    },
    diagnostics,
    valid: errors.length === 0,
  };
}

function renderText(result) {
  const lines = [
    `Cases: ${result.summary.cases}; scenario families: ${result.summary.scenario_families}`,
    `Errors: ${result.summary.errors}; warnings: ${result.summary.warnings}`,
  ];
  for (const item of result.diagnostics) {
    const location = item.case_id ? ` [${item.case_id}]` : '';
    lines.push(`${item.level.toUpperCase()} ${item.code}${location}: ${item.message}`);
  }
  return lines.join('\n');
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('Usage: validate-eval-cases.mjs <eval-cases.json> [--strict] [--format text|json]\n');
      return;
    }
    const data = JSON.parse(await readFile(options.input, 'utf8'));
    const result = validate(data, options.input, options.strict);
    process.stdout.write(options.format === 'json'
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${renderText(result)}\n`);
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

await main();
