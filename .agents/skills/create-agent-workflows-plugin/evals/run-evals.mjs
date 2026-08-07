#!/usr/bin/env node

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.dirname(EVAL_ROOT);
const REPO_ROOT = path.resolve(SKILL_ROOT, '..', '..', '..');
const SKILL_NAME = 'create-agent-workflows-plugin';
const SUITES = [
  {
    id: 'trigger',
    kind: 'trigger',
    skill: SKILL_NAME,
    cases: './evals/trigger-cases.json',
    observeSpawnAgent: false,
    isolation: 'standard',
    strictNegativeSplits: ['validation'],
    profiles: ['project-default'],
    defaultRuns: 3,
    releaseSplits: ['validation'],
    requiredForRelease: true,
    perRunTimeoutMs: 180000,
  },
  {
    id: 'behavior',
    kind: 'conversation',
    skill: SKILL_NAME,
    cases: './evals/evals.json',
    profiles: ['project-default'],
    defaultRuns: 1,
    releaseSplits: [],
    requiredForRelease: true,
    perRunTimeoutMs: 300000,
  },
];

function fail(message) {
  throw new Error(message);
}

function usage() {
  return `Usage:
  node .agents/skills/create-agent-workflows-plugin/evals/run-evals.mjs --validate-only
  node .agents/skills/create-agent-workflows-plugin/evals/run-evals.mjs [options] --output-dir <path>

Options:
  --suite <trigger|behavior|all>  Suite to run. Default: all
  --split <train|validation|all>  Trigger split. Default: validation
  --case <id>                     Run one case; requires a non-all suite
  --runs <count>                  Override the suite repetition count
  --model <model>                 Override the Codex model
  --codex-bin <path>              Codex executable. Default: codex
  --output-dir <path>             New directory for subject, traces, and evaluation.json
  --validate-only                 Validate eval definitions without starting Codex
  -h, --help                      Show this help
`;
}

function optionValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    fail(`${flag} requires a value.`);
  }
  return value;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    suite: 'all',
    split: 'validation',
    codexBin: 'codex',
    validateOnly: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === '--validate-only') {
      options.validateOnly = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      fail(`Unexpected positional argument: ${arg}`);
    }
    const value = optionValue(args, index, arg);
    index += 1;
    if (arg === '--suite') options.suite = value;
    else if (arg === '--split') options.split = value;
    else if (arg === '--case') options.caseId = value;
    else if (arg === '--runs') options.runs = Number(value);
    else if (arg === '--model') options.model = value;
    else if (arg === '--codex-bin') options.codexBin = value;
    else if (arg === '--output-dir') options.outputDir = path.resolve(value);
    else fail(`Unknown option: ${arg}`);
  }
  if (!['trigger', 'behavior', 'all'].includes(options.suite)) {
    fail('--suite must be trigger, behavior, or all.');
  }
  if (!['train', 'validation', 'all'].includes(options.split)) {
    fail('--split must be train, validation, or all.');
  }
  if (options.runs !== undefined && (!Number.isInteger(options.runs) || options.runs <= 0)) {
    fail('--runs must be a positive integer.');
  }
  if (options.caseId && options.suite === 'all') {
    fail('--case requires --suite trigger or --suite behavior.');
  }
  if (options.suite === 'behavior' && options.split !== 'validation') {
    fail('--split only applies to the trigger suite.');
  }
  if (!options.validateOnly && !options.outputDir) {
    fail('--output-dir is required unless --validate-only is used.');
  }
  return options;
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(SKILL_ROOT, relativePath), 'utf8'));
}

function assertUniqueStringIds(rows, label) {
  const ids = rows.map((entry, index) => {
    if (typeof entry?.id !== 'string' || entry.id.trim() === '') {
      fail(`${label}[${index}].id must be a non-empty string.`);
    }
    return entry.id.trim();
  });
  if (new Set(ids).size !== ids.length) {
    fail(`${label} has duplicate ids.`);
  }
}

async function validateDefinitions() {
  const [triggerCases, behaviorDocument] = await Promise.all([
    readJson('evals/trigger_queries.json'),
    readJson('evals/evals.json'),
  ]);
  if (!Array.isArray(triggerCases)) {
    fail('evals/trigger_queries.json must contain a list.');
  }
  assertUniqueStringIds(triggerCases, 'trigger cases');
  for (const [index, entry] of triggerCases.entries()) {
    if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(entry.id)) {
      fail(`trigger cases[${index}].id must use lowercase snake_case.`);
    }
    if (!['train', 'validation'].includes(entry.split)) {
      fail(`trigger cases[${index}].split must be train or validation.`);
    }
    if (typeof entry.query !== 'string' || entry.query.trim() === '') {
      fail(`trigger cases[${index}].query must be non-empty.`);
    }
    if (typeof entry.should_trigger !== 'boolean') {
      fail(`trigger cases[${index}].should_trigger must be boolean.`);
    }
    if (!Array.isArray(entry.tags) || entry.tags.length === 0) {
      fail(`trigger cases[${index}].tags must be non-empty.`);
    }
  }
  const count = (predicate) => triggerCases.filter(predicate).length;
  if (
    triggerCases.length !== 20 ||
    count((entry) => entry.split === 'train') !== 12 ||
    count((entry) => entry.split === 'validation') !== 8 ||
    count((entry) => entry.should_trigger) !== 10 ||
    count((entry) => !entry.should_trigger) !== 10
  ) {
    fail('trigger corpus must contain 20 balanced cases split 12 train / 8 validation.');
  }

  if (behaviorDocument.skill_name !== SKILL_NAME || !Array.isArray(behaviorDocument.evals)) {
    fail('evals/evals.json has an invalid document shape.');
  }
  assertUniqueStringIds(behaviorDocument.evals, 'behavior cases');
  if (behaviorDocument.evals.length !== 3) {
    fail('evals/evals.json must retain three behavior seed cases.');
  }
  for (const [index, entry] of behaviorDocument.evals.entries()) {
    if (
      typeof entry.prompt !== 'string' ||
      typeof entry.expected_output !== 'string' ||
      !Array.isArray(entry.files) ||
      !Array.isArray(entry.scripted_replies) ||
      entry.review?.workspace_unchanged !== true ||
      !Array.isArray(entry.review?.checks) ||
      entry.review.checks.length < 4
    ) {
      fail(`behavior cases[${index}] has an invalid trace-review contract.`);
    }
  }
  return {
    suites: SUITES,
    triggerCases: triggerCases.length,
    triggerDocument: {
      schemaVersion: 1,
      skill: SKILL_NAME,
      cases: triggerCases.map((entry) => ({
        id: entry.id,
        split: entry.split,
        query: entry.query,
        should_load_skill: entry.should_trigger,
        tags: entry.tags,
      })),
    },
    behaviorDocument,
    behaviorCases: behaviorDocument.evals.length,
  };
}

async function loadCentralDrivers() {
  const scriptsRoot = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'scripts');
  const paths = {
    contract: path.join(scriptsRoot, 'plugin-eval-contract.js'),
    trigger: path.join(scriptsRoot, 'codex-trigger-eval.js'),
    behavior: path.join(scriptsRoot, 'codex-eval-app-server.js'),
  };
  for (const filePath of Object.values(paths)) {
    try {
      await fs.access(filePath);
    } catch {
      fail(`Built eval driver not found: ${filePath}. Run pnpm build first.`);
    }
  }
  const [contract, trigger, behavior] = await Promise.all([
    import(pathToFileURL(paths.contract).href),
    import(pathToFileURL(paths.trigger).href),
    import(pathToFileURL(paths.behavior).href),
  ]);
  return { contract, trigger, behavior };
}

async function ensureNewDirectory(directory) {
  try {
    await fs.access(directory);
    fail(`Output directory already exists: ${directory}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(directory, { recursive: true });
}

async function prepareSubject(outputRoot) {
  const subjectRoot = path.join(outputRoot, 'subject');
  const targetSkillRoot = path.join(subjectRoot, '.agents', 'skills', SKILL_NAME);
  await fs.mkdir(path.dirname(targetSkillRoot), { recursive: true });
  await fs.cp(SKILL_ROOT, targetSkillRoot, { recursive: true });
  await fs.mkdir(path.join(subjectRoot, 'plugins'), { recursive: true });
  await fs.copyFile(
    path.join(REPO_ROOT, 'plugins', 'marketplace-source.json'),
    path.join(subjectRoot, 'plugins', 'marketplace-source.json'),
  );
  await fs.cp(
    path.join(SKILL_ROOT, 'references', '.examples', 'code-review'),
    path.join(subjectRoot, 'plugins', 'code-review'),
    { recursive: true },
  );
  for (const name of ['package.json', 'pnpm-workspace.yaml']) {
    await fs.copyFile(path.join(REPO_ROOT, name), path.join(subjectRoot, name));
  }
  await fs.writeFile(
    path.join(subjectRoot, 'AGENTS.md'),
    '# Eval fixture\n\nThis is an agent-workflows authoring fixture. Plugin source is under `plugins/`. Keep all evaluation work read-only.\n',
    'utf8',
  );
  return subjectRoot;
}

async function prepareDriverRoot(root, triggerDocument) {
  const driverRoot = path.join(root, 'driver');
  await fs.mkdir(path.join(driverRoot, 'evals'), { recursive: true });
  await fs.writeFile(
    path.join(driverRoot, 'evals', 'trigger-cases.json'),
    `${JSON.stringify(triggerDocument, null, 2)}\n`,
    'utf8',
  );
  return driverRoot;
}

async function validateWithCentralContract(drivers, definitions, root) {
  const driverRoot = await prepareDriverRoot(root, definitions.triggerDocument);
  const triggerSuite = definitions.suites.find((suite) => suite.id === 'trigger');
  await drivers.contract.readPluginEvalTriggerCases(driverRoot, triggerSuite);
  drivers.contract.validatePluginEvalConversationCaseDocument(
    definitions.behaviorDocument,
    SKILL_NAME,
  );
  return driverRoot;
}

async function codexVersion(codexBin) {
  try {
    const result = await execFileAsync(codexBin, ['--version'], {
      env: process.env,
      timeout: 10000,
      encoding: 'utf8',
    });
    return result.stdout.trim() || result.stderr.trim() || null;
  } catch {
    return null;
  }
}

async function detectEnvironmentIssue(reportPath) {
  const report = await fs.readFile(reportPath, 'utf8');
  if (
    report.includes('refresh_token_reused') ||
    report.includes('token_expired') ||
    report.includes('Please log out and sign in again')
  ) {
    return 'Codex authentication is expired; sign in again before rerunning model evals.';
  }
  if (report.includes('sandbox_apply: Operation not permitted')) {
    return 'Nested Codex could not initialize its read-only sandbox; rerun outside the outer sandbox.';
  }
  return null;
}

async function run(options, definitions) {
  const drivers = await loadCentralDrivers();
  await ensureNewDirectory(options.outputDir);
  const subjectRoot = await prepareSubject(options.outputDir);
  const driverRoot = await validateWithCentralContract(drivers, definitions, options.outputDir);
  const reportsRoot = path.join(options.outputDir, 'reports');
  await fs.mkdir(reportsRoot, { recursive: true });
  const selectedSuites = definitions.suites.filter(
    (suite) => options.suite === 'all' || suite.id === options.suite,
  );
  const reports = [];
  for (const suite of selectedSuites) {
    const reportPath = path.join(
      reportsRoot,
      suite.kind === 'trigger' ? `${suite.id}-${options.split}.json` : `${suite.id}.json`,
    );
    let report;
    if (suite.kind === 'trigger') {
      report = await drivers.trigger.runCodexTriggerSuite({
        suite,
        split: options.split,
        subjectRoot,
        pluginRoot: driverRoot,
        profile: 'project-default',
        runs: options.runs ?? suite.defaultRuns,
        caseId: options.caseId,
        codexBin: options.codexBin,
        model: options.model,
        sourceEnv: process.env,
        reportPath,
        stderr: (message) => process.stderr.write(message),
      });
    } else {
      report = await drivers.behavior.runCodexConversationSuite({
        suiteId: suite.id,
        skillName: suite.skill,
        casesPath: path.join(SKILL_ROOT, suite.cases.replace(/^\.\//u, '')),
        subjectRoot,
        profile: 'project-default',
        runs: options.runs ?? suite.defaultRuns,
        caseId: options.caseId,
        codexBin: options.codexBin,
        model: options.model,
        timeoutMs: suite.perRunTimeoutMs,
        sourceEnv: process.env,
        reportPath,
      });
    }
    const environmentIssue = await detectEnvironmentIssue(reportPath);
    if (environmentIssue) {
      report.outcome = 'incomplete';
      report.complete = false;
      report.mechanicalPassed = false;
      report.diagnostics = [...report.diagnostics, environmentIssue];
    }
    report.reportPath = path.relative(options.outputDir, reportPath).split(path.sep).join('/');
    reports.push(report);
  }
  const outcome = drivers.contract.combinePluginEvalOutcome(reports);
  const evaluation = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    skill: SKILL_NAME,
    platform: 'codex',
    codexVersion: await codexVersion(options.codexBin),
    model: options.model ?? null,
    outcome,
    complete: reports.every((report) => report.complete),
    mechanicalPassed: reports.every((report) => report.mechanicalPassed),
    subject: 'subject',
    suites: reports,
    diagnostics: reports.flatMap((report) => report.diagnostics),
  };
  const evaluationPath = path.join(options.outputDir, 'evaluation.json');
  await fs.writeFile(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    ok: evaluation.complete && outcome !== 'failed' && outcome !== 'incomplete',
    outcome,
    evaluation: evaluationPath,
  }, null, 2)}\n`);
  if (outcome === 'failed' || outcome === 'incomplete') {
    process.exitCode = 1;
  }
}

async function main() {
  const options = parseArgs(process.argv);
  const definitions = await validateDefinitions();
  if (options.validateOnly) {
    let centralContract = false;
    let tempRoot;
    try {
      const drivers = await loadCentralDrivers();
      tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'create-plugin-eval-'));
      await validateWithCentralContract(drivers, definitions, tempRoot);
      centralContract = true;
    } catch (error) {
      if (!String(error?.message).includes('Built eval driver not found')) throw error;
    } finally {
      if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      triggerCases: definitions.triggerCases,
      behaviorCases: definitions.behaviorCases,
      centralContract,
    }, null, 2)}\n`);
    return;
  }
  await run(options, definitions);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { detectEnvironmentIssue, parseArgs, validateDefinitions };
