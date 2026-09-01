#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SUITE_KINDS = new Set(['trigger', 'conversation', 'custom-process', 'codex-workflow']);
const CONDITIONAL_AUDIT_FIELDS = new Map([
  ['boundary', ['rationale', 'minimalCounterexample']],
  ['regression', ['rationale', 'minimalCounterexample']],
  ['release-critical', ['errorCost']],
  ['high-cost', ['errorCost']],
  ['high-variance', ['allowedVariance']],
]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
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
    else throw new Error('Only one selected case file may be supplied.');
  }
  if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json.');
  if (!help && !input) {
    throw new Error('Usage: validate-eval-cases.mjs <cases.json> [--strict] [--format text|json]');
  }
  return { input, format, strict, help };
}

function add(diagnostics, level, code, message, caseId = null) {
  diagnostics.push({ level, code, message, case_id: caseId });
}

function validatePolicy(suite, diagnostics) {
  if (!isRecord(suite.policy)) {
    add(diagnostics, 'error', 'suite.policy', 'suite.policy must define optimization and error costs.');
    return;
  }
  for (const field of ['optimization', 'falseNegativeCost', 'falsePositiveCost', 'rationale']) {
    if (!hasText(suite.policy[field])) {
      add(diagnostics, 'error', `suite.policy.${field}`, `suite.policy.${field} must be non-empty.`);
    }
  }
}

function validateSuite(suite, diagnostics, strict) {
  if (!isRecord(suite)) {
    add(diagnostics, 'error', 'suite.type', 'suite must be an object.');
    return null;
  }
  if (!SUITE_KINDS.has(suite.kind)) {
    add(
      diagnostics,
      'error',
      'suite.kind',
      'suite.kind must be trigger, conversation, custom-process, or codex-workflow.',
    );
  }
  if (!hasText(suite.unitUnderTest)) {
    add(diagnostics, 'error', 'suite.unit-under-test', 'suite.unitUnderTest must be non-empty.');
  }
  validatePolicy(suite, diagnostics);
  if (suite.runtime !== undefined && !isRecord(suite.runtime)) {
    add(diagnostics, 'error', 'suite.runtime', 'suite.runtime must be an object when present.');
  }
  return suite.kind;
}

function validateConditionalAudit(evalCase, tags, diagnostics, caseId) {
  const required = new Set(tags.flatMap((tag) => CONDITIONAL_AUDIT_FIELDS.get(tag) ?? []));
  if (required.size === 0) return;
  if (!isRecord(evalCase.audit)) {
    add(diagnostics, 'error', 'case.audit', 'Tagged case requires conditional audit metadata.', caseId);
    return;
  }
  for (const field of required) {
    if (!hasText(evalCase.audit[field])) {
      add(
        diagnostics,
        'error',
        `case.audit.${field}`,
        `case audit metadata ${field} is required by tags.`,
        caseId,
      );
    }
  }
}

function validateTrigger(evalCase, diagnostics, caseId) {
  if (!isRecord(evalCase.input) || !hasText(evalCase.input.query)) {
    add(diagnostics, 'error', 'case.trigger-input', 'Trigger case requires input.query.', caseId);
    return;
  }
  const hasBoolean = typeof evalCase.input.expectedLoad === 'boolean';
  const loaded = evalCase.input.expected?.loadedSkills;
  const hasLoadedSkills = Array.isArray(loaded) && loaded.every(hasText);
  if (hasBoolean === hasLoadedSkills) {
    add(
      diagnostics,
      'error',
      'case.trigger-expectation',
      'Trigger case requires exactly one of input.expectedLoad or input.expected.loadedSkills.',
      caseId,
    );
  }
}

function validateConversation(evalCase, diagnostics, caseId) {
  if (!hasText(evalCase.prompt)) {
    add(diagnostics, 'error', 'case.conversation-prompt', 'Conversation case requires prompt.', caseId);
  }
  if (!Array.isArray(evalCase.assertions) || evalCase.assertions.length === 0 || !evalCase.assertions.every(hasText)) {
    add(
      diagnostics,
      'error',
      'case.conversation-assertions',
      'Conversation case requires non-empty observable assertions.',
      caseId,
    );
  }
}

function validateCustom(evalCase, diagnostics, caseId) {
  if (![evalCase.input, evalCase.expected, evalCase.assertions].some((value) => value !== undefined)) {
    add(
      diagnostics,
      'error',
      'case.custom-contract',
      'Custom-process case requires provider input, expected data, or assertions.',
      caseId,
    );
  }
}

function validateCodexWorkflow(evalCase, diagnostics, caseId) {
  if (!isRecord(evalCase.input)) {
    add(
      diagnostics,
      'error',
      'case.codex-workflow-input',
      'Codex-workflow case requires provider input.',
      caseId,
    );
  }
  if (![evalCase.expected, evalCase.assertions].some((value) => value !== undefined)) {
    add(
      diagnostics,
      'error',
      'case.codex-workflow-contract',
      'Codex-workflow case requires expected data or assertions.',
      caseId,
    );
  }
}

function validateCase(evalCase, kind, index, seen, diagnostics) {
  if (!isRecord(evalCase)) {
    add(diagnostics, 'error', 'case.type', `Case #${index} must be an object.`);
    return;
  }
  const caseId = hasText(evalCase.id) ? evalCase.id : `#${index}`;
  if (!hasText(evalCase.id)) add(diagnostics, 'error', 'case.id', 'Case requires a non-empty id.', caseId);
  if (seen.has(caseId)) add(diagnostics, 'error', 'case.duplicate-id', 'Case id must be unique.', caseId);
  seen.add(caseId);
  if (!hasText(evalCase.split)) add(diagnostics, 'error', 'case.split', 'Case requires a non-empty split.', caseId);
  if (!Array.isArray(evalCase.tags) || !evalCase.tags.every(hasText)) {
    add(diagnostics, 'error', 'case.tags', 'Case tags must be an array of non-empty strings.', caseId);
  }
  const tags = Array.isArray(evalCase.tags) ? evalCase.tags.filter(hasText) : [];
  if (kind === 'trigger') validateTrigger(evalCase, diagnostics, caseId);
  else if (kind === 'conversation') validateConversation(evalCase, diagnostics, caseId);
  else if (kind === 'custom-process') validateCustom(evalCase, diagnostics, caseId);
  else if (kind === 'codex-workflow') validateCodexWorkflow(evalCase, diagnostics, caseId);
  validateConditionalAudit(evalCase, tags, diagnostics, caseId);
}

function validateDocument(value, strict) {
  const diagnostics = [];
  if (!isRecord(value)) {
    add(diagnostics, 'error', 'document.type', 'Selected cases document must be an object.');
    return diagnostics;
  }
  if (value.version !== 1) add(diagnostics, 'error', 'document.version', 'Selected cases version must be 1.');
  const kind = validateSuite(value.suite, diagnostics, strict);
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    add(diagnostics, 'error', 'document.cases', 'cases must be a non-empty array.');
    return diagnostics;
  }
  const seen = new Set();
  value.cases.forEach((evalCase, index) => validateCase(evalCase, kind, index, seen, diagnostics));
  return diagnostics;
}

function render(result, format) {
  if (format === 'json') return `${JSON.stringify(result, null, 2)}\n`;
  const lines = result.diagnostics.map((item) => {
    const caseLabel = item.case_id ? ` (${item.case_id})` : '';
    return `[${item.level.toUpperCase()}] ${item.code}${caseLabel}: ${item.message}`;
  });
  lines.push(result.valid ? 'Eval case audit checks passed.' : 'Eval case audit checks failed.');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: validate-eval-cases.mjs <cases.json> [--strict] [--format text|json]\n');
    return;
  }
  const value = JSON.parse(await readFile(options.input, 'utf8'));
  const diagnostics = validateDocument(value, options.strict);
  const errors = diagnostics.filter((item) => item.level === 'error').length;
  const warnings = diagnostics.filter((item) => item.level === 'warning').length;
  const result = {
    valid: errors === 0,
    summary: { errors, warnings, cases: Array.isArray(value?.cases) ? value.cases.length : 0 },
    diagnostics,
  };
  process.stdout.write(render(result, options.format));
  if (!result.valid) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`[ERROR] ${error.message}\n`);
  process.exitCode = 2;
});
