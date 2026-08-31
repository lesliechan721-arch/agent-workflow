import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const INPUT_KEYS = [
  'attempt',
  'case',
  'fixturesPath',
  'outputDir',
  'variant',
  'version',
  'workspacePath',
];

const SECRET_ENVIRONMENT = [
  'ALL_PROXY',
  'AW_SKILL_EVAL_CODEX_BIN',
  'AW_SKILL_EVAL_CODEX_MODEL',
  'CODEX_HOME',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
];

function redactError(error) {
  const source = error instanceof Error ? error.stack ?? error.message : String(error);
  return SECRET_ENVIRONMENT.reduce((result, name) => {
    const secret = process.env[name];
    if (!secret) return result;
    const encoded = JSON.stringify(secret).slice(1, -1);
    return result.replaceAll(secret, '[redacted]').replaceAll(encoded, '[redacted]');
  }, source);
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} must contain only ${expected.join(', ')}.`);
  }
}

function parseInput(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`stdin must contain one JSON object: ${error.message}`);
  }
  const input = record(value, 'custom process input');
  exactKeys(input, INPUT_KEYS, 'custom process input');
  if (input.version !== 1) {
    throw new Error('custom process input.version must be 1.');
  }
  if (!['current', 'without-skill', 'previous-version'].includes(input.variant)) {
    throw new Error('custom process input.variant is invalid.');
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error('custom process input.attempt must be a positive safe integer.');
  }
  for (const key of ['workspacePath', 'fixturesPath', 'outputDir']) {
    if (typeof input[key] !== 'string' || !path.isAbsolute(input[key])) {
      throw new Error(`custom process input.${key} must be an absolute path.`);
    }
  }
  record(input.case, 'custom process input.case');
  return input;
}

function legacyCase(selectedCase) {
  const input = selectedCase.input === undefined
    ? {}
    : record(selectedCase.input, 'custom process input.case.input');
  const result = { id: selectedCase.id, ...input };
  if (selectedCase.expected !== undefined) {
    const expected = record(
      selectedCase.expected,
      'custom process input.case.expected',
    );
    if (Object.hasOwn(expected, 'criteria')) result.expected = expected.criteria;
    if (Object.hasOwn(expected, 'outcome')) result.expected_output = expected.outcome;
  }
  if (selectedCase.assertions !== undefined) {
    result.assertions = selectedCase.assertions;
  }
  return result;
}

function legacyInput(input) {
  const skillMode = input.variant === 'current' ? 'with-skill' : input.variant;
  return {
    case: legacyCase(input.case),
    caseId: input.case.id,
    configuration: skillMode,
    skillMode,
    workspacePath: input.workspacePath,
    fixturesPath: input.fixturesPath,
    outputDir: input.outputDir,
    attempt: input.attempt,
  };
}

function usage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const inputTokens = value.inputTokens ?? value.input_tokens;
  const outputTokens = value.outputTokens ?? value.output_tokens;
  if (
    !Number.isSafeInteger(inputTokens)
    || inputTokens < 0
    || !Number.isSafeInteger(outputTokens)
    || outputTokens < 0
  ) return null;
  return { inputTokens, outputTokens };
}

function output(value) {
  const result = record(value, 'provider result');
  const grading = record(result.grading, 'provider result.grading');
  const gradeResult = record(grading.result, 'provider result.grading.result');
  if (typeof gradeResult.passed !== 'boolean') {
    throw new Error('provider grade passed result must be boolean.');
  }
  const passed = gradeResult.passed && gradeResult.complete !== false;
  return {
    version: 1,
    usage: usage(result.usage),
    grade: {
      passed,
      score: passed ? 1 : 0,
      details: gradeResult,
    },
  };
}

async function stdin() {
  process.stdin.setEncoding('utf8');
  let source = '';
  for await (const chunk of process.stdin) source += chunk;
  return source;
}

export async function runCustomProcessMain(moduleUrl, runner) {
  if (
    !process.argv[1]
    || realpathSync(process.argv[1]) !== realpathSync(fileURLToPath(moduleUrl))
  ) return;
  try {
    const input = parseInput(await stdin());
    const result = await runner(legacyInput(input));
    process.stdout.write(JSON.stringify(output(result)));
  } catch (error) {
    process.stderr.write(`${redactError(error)}\n`);
    process.exitCode = 1;
  }
}
