#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { copyRuntimeSkill, isPathInside, runtimeSkillDigest } from './lib/runtime-skill.mjs';
import { validatePlan } from './validate-eval-execution-plan.mjs';

const execFileAsync = promisify(execFile);

function usage() {
  return 'Usage: run-agent-skill-evals.mjs <plan.json> [--validate-only] [--format text|json]';
}
function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let validateOnly = false;
  let format = 'text';
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--validate-only') validateOnly = true;
    else if (value === '--format') format = argv[++index];
    else if (value.startsWith('-')) throw new Error(`Unknown option: ${value}`);
    else positional.push(path.resolve(value));
  }
  if (positional.length !== 1) throw new Error(usage());
  if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json.');
  return { planPath: positional[0], validateOnly, format };
}
function sha256(data) { return `sha256:${createHash('sha256').update(data).digest('hex')}`; }
function casesFrom(document) {
  if (Array.isArray(document)) return document;
  if (Array.isArray(document.cases)) return document.cases;
  if (Array.isArray(document.evals)) return document.evals;
  throw new Error('case document must be an array or contain cases/evals');
}
function promptOf(evalCase) {
  if (typeof evalCase.query === 'string') return evalCase.query;
  if (typeof evalCase.prompt === 'string') return evalCase.prompt;
  if (typeof evalCase.input === 'string') return evalCase.input;
  if (Array.isArray(evalCase.messages)) {
    const userMessage = [...evalCase.messages].reverse().find((message) => message.role === 'user' && typeof message.content === 'string');
    if (userMessage) return userMessage.content;
  }
  throw new Error(`case ${evalCase.id ?? '?'} has no prompt/query/input`);
}
function replacePlaceholder(value, replacements) {
  return value.replace(/\{(prompt|caseId|configuration|skillPath|outputDir)\}/gu, (_, key) => replacements[key]);
}
async function providerArtifacts(parsed, runDirectory, outputRoot) {
  if (!Array.isArray(parsed?.artifacts)) return [];
  const artifacts = [];
  for (const entry of parsed.artifacts) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') throw new Error('provider artifact requires path');
    const role = typeof entry.role === 'string' ? entry.role : 'other';
    if (!['trace', 'report', 'output', 'grading', 'other'].includes(role)) throw new Error(`unsupported provider artifact role: ${role}`);
    const candidate = path.resolve(runDirectory, entry.path);
    if (!isPathInside(runDirectory, candidate)) throw new Error('provider artifact leaves the run directory');
    if ((await lstat(candidate)).isSymbolicLink()) throw new Error('provider artifact cannot be a symlink');
    const actual = await realpath(candidate);
    if (!isPathInside(runDirectory, actual) || !(await stat(actual)).isFile()) throw new Error('provider artifact is not a regular run file');
    artifacts.push({ role, path: path.relative(outputRoot, actual).split(path.sep).join('/'), digest: sha256(await readFile(actual)) });
  }
  return artifacts;
}
async function runOne({ plan, base, skillSource, evalCase, configuration, runIndex }) {
  const caseId = String(evalCase.id);
  const outputRoot = path.resolve(base, plan.outputRoot);
  const runDirectory = path.resolve(outputRoot, caseId, configuration.id, String(runIndex));
  await rm(runDirectory, { recursive: true, force: true });
  await mkdir(runDirectory, { recursive: true });
  const skillSnapshot = skillSource.root ? path.join(runDirectory, 'skill') : null;
  if (skillSnapshot) await copyRuntimeSkill(skillSource.root, skillSnapshot);
  const casePath = path.join(runDirectory, 'case.json');
  await writeFile(casePath, `${JSON.stringify(evalCase, null, 2)}\n`, 'utf8');
  const replacements = { prompt: promptOf(evalCase), caseId, configuration: configuration.id, skillPath: skillSnapshot ?? '', outputDir: runDirectory };
  const argv = plan.provider.command.map((value) => replacePlaceholder(value, replacements));
  const executable = argv.shift();
  const inheritedEnvironment = plan.provider.inheritEnvironment
    ? process.env
    : Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR'].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  const env = {
    ...inheritedEnvironment,
    ...plan.provider.env,
    ...configuration.env,
    AGENT_EVAL_CASE_ID: caseId,
    AGENT_EVAL_CONFIGURATION: configuration.id,
    AGENT_EVAL_SKILL_MODE: configuration.skillMode,
    AGENT_EVAL_OUTPUT_DIR: runDirectory,
    AGENT_EVAL_CASE_PATH: casePath,
    ...(skillSnapshot ? { AGENT_EVAL_SKILL_PATH: skillSnapshot } : {}),
  };
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let status = 'completed';
  try {
    const result = await execFileAsync(executable, argv, {
      cwd: plan.provider.cwd ? path.resolve(base, plan.provider.cwd) : runDirectory,
      env,
      encoding: 'utf8',
      timeout: plan.timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    stdout = typeof error.stdout === 'string' ? error.stdout : '';
    stderr = typeof error.stderr === 'string' ? error.stderr : String(error.message ?? error);
    exitCode = Number.isInteger(error.code) ? error.code : null;
    status = error.killed || error.code === 'ETIMEDOUT' ? 'timeout' : 'process-failed';
  }
  const stdoutPath = path.join(runDirectory, 'stdout.txt');
  const stderrPath = path.join(runDirectory, 'stderr.txt');
  await Promise.all([writeFile(stdoutPath, stdout, 'utf8'), writeFile(stderrPath, stderr, 'utf8')]);
  let usage = null;
  let grading = null;
  let artifacts = [];
  try {
    const parsed = JSON.parse(stdout.trim());
    usage = parsed.usage ?? null;
    grading = parsed.grading ?? null;
    artifacts = await providerArtifacts(parsed, runDirectory, outputRoot);
  } catch (error) {
    if (stdout.trim().startsWith('{') && status === 'completed') {
      status = 'error';
      stderr += `${stderr ? '\n' : ''}Provider JSON/artifact error: ${error.message}`;
      await writeFile(stderrPath, stderr, 'utf8');
    }
  }
  return {
    caseId,
    configuration: configuration.id,
    skillMode: configuration.skillMode,
    skillDigest: skillSource.digest,
    runIndex,
    status,
    exitCode,
    durationMs: Date.now() - started,
    stdoutPath: path.relative(outputRoot, stdoutPath).split(path.sep).join('/'),
    stdoutDigest: sha256(stdout),
    stderrPath: path.relative(outputRoot, stderrPath).split(path.sep).join('/'),
    stderrDigest: sha256(stderr),
    usage,
    grading,
    artifacts,
  };
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(`${usage()}\n`); return; }
  const validation = await validatePlan(options.planPath);
  if (!validation.valid) { process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`); process.exit(1); }
  if (options.validateOnly) { process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`); return; }
  const planRaw = await readFile(options.planPath, 'utf8');
  const plan = JSON.parse(planRaw);
  const base = path.dirname(options.planPath);
  const sourceTarget = await realpath(path.resolve(base, plan.target.path));
  const targetDigestBefore = await runtimeSkillDigest(sourceTarget);
  if (targetDigestBefore !== plan.target.digest) throw new Error('target Skill changed after plan validation');
  const configurationSources = new Map();
  for (const configuration of plan.configurations) {
    if (configuration.skillMode === 'with-skill') configurationSources.set(configuration.id, { root: sourceTarget, digest: targetDigestBefore });
    else if (configuration.skillMode === 'without-skill') configurationSources.set(configuration.id, { root: null, digest: null });
    else {
      const previousRoot = await realpath(path.resolve(base, configuration.skillPath));
      const previousDigest = await runtimeSkillDigest(previousRoot);
      if (previousDigest !== configuration.skillDigest) throw new Error(`${configuration.id} previous-version Skill changed after plan validation`);
      configurationSources.set(configuration.id, { root: previousRoot, digest: previousDigest });
    }
  }
  const providerCapabilities = JSON.parse(await readFile(path.resolve(base, plan.provider.capabilitiesPath), 'utf8'));
  const documents = await Promise.all(plan.cases.paths.map((entry) => readFile(path.resolve(base, entry), 'utf8').then(JSON.parse)));
  const cases = new Map();
  for (const document of documents) for (const evalCase of casesFrom(document)) cases.set(String(evalCase.id), evalCase);
  const runs = [];
  for (const evalCase of cases.values()) {
    for (const configuration of plan.configurations) {
      const skillSource = configurationSources.get(configuration.id);
      for (let runIndex = 1; runIndex <= plan.runsPerCase; runIndex += 1) runs.push(await runOne({ plan, base, skillSource, evalCase, configuration, runIndex }));
    }
  }
  for (const [configurationId, source] of configurationSources) {
    if (!source.root) continue;
    if (await runtimeSkillDigest(source.root) !== source.digest) throw new Error(`${configurationId} Skill changed during Eval execution; no evidence bundle was accepted`);
  }
  const outputRoot = path.resolve(base, plan.outputRoot);
  const modes = new Set(plan.configurations.map((entry) => entry.skillMode));
  const evidenceLevel = modes.has('with-skill') && (modes.has('without-skill') || modes.has('previous-version')) ? 'comparative' : 'executed';
  const limitations = [...providerCapabilities.limitations];
  if (!providerCapabilities.capabilities.cleanContext) limitations.push('Provider does not prove a clean model context.');
  if (!providerCapabilities.capabilities.toolTrace) limitations.push('Provider does not capture a tool trace.');
  if (!providerCapabilities.capabilities.tokenUsage) limitations.push('Provider does not capture token usage.');
  limitations.push('A completed provider process is not an Eval pass; grading and Skill-defect attribution remain separate.');
  const bundle = {
    schemaVersion: 1,
    producer: 'run-agent-skill-evals',
    independentContext: providerCapabilities.capabilities.cleanContext === true,
    provider: { id: plan.provider.id, version: providerCapabilities.providerVersion },
    planDigest: sha256(planRaw),
    targetSkillDigest: plan.target.digest,
    caseCorpusDigest: plan.cases.corpusDigest,
    preflightAuditDigest: plan.audit.digest,
    evidenceLevel,
    runs,
    aggregate: {
      cases: cases.size,
      configurations: plan.configurations.length,
      runs: runs.length,
      completed: runs.filter((entry) => entry.status === 'completed').length,
      processFailed: runs.filter((entry) => entry.status === 'process-failed' || entry.status === 'error').length,
      timedOut: runs.filter((entry) => entry.status === 'timeout').length,
    },
    limitations: [...new Set(limitations)],
  };
  await mkdir(outputRoot, { recursive: true });
  const bundlePath = path.join(outputRoot, 'eval-run-bundle.json');
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  const result = { valid: true, bundlePath, bundleDigest: sha256(await readFile(bundlePath)), evidenceLevel };
  process.stdout.write(options.format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : `${bundlePath}\n`);
}
main().catch((error) => { process.stderr.write(`[ERROR] ${error.message}\n`); process.exit(1); });
