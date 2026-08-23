import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const localRoot = path.dirname(fileURLToPath(import.meta.url));
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = context?.sourceRoot ?? path.resolve(localRoot, '..');
const scriptRoot = context
  ? path.join(context.plugin.rootDir, context.platform, 'skills', 'review-aw-plugin', 'scripts')
  : localRoot;
const releaseChecker = path.join(scriptRoot, 'check-aw-plugin-release.mjs');
const skillChecker = context
  ? path.join(scriptRoot, 'check-agent-skill.mjs')
  : path.resolve(localRoot, '..', '..', 'agent-skill-toolkit', 'scripts', 'check-agent-skill.mjs');
const reviewValidator = context
  ? path.join(scriptRoot, 'validate-review-result-lite.mjs')
  : path.resolve(localRoot, '..', '..', 'agent-skill-toolkit', 'scripts', 'validate-review-result-lite.mjs');
const auditValidator = context
  ? path.join(scriptRoot, 'validate-eval-audit-result.mjs')
  : path.resolve(localRoot, '..', '..', 'agent-skill-toolkit', 'scripts', 'validate-eval-audit-result.mjs');
const bundleValidator = context
  ? path.join(scriptRoot, 'validate-eval-run-bundle.mjs')
  : path.resolve(localRoot, '..', '..', 'agent-skill-toolkit', 'scripts', 'validate-eval-run-bundle.mjs');
const skillValidatorBin = path.resolve(sourceRoot, '..', '..', 'packages', 'cli', 'dist', 'index.js');
const dimensions = [
  'specification', 'problem_value', 'triggering', 'scope_composition',
  'instruction_design', 'minimum_control', 'context_disclosure', 'architecture',
  'scripts', 'evals', 'reliability', 'maintainability',
];

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function runJson(file, args, env) {
  try {
    const result = await execFileAsync(process.execPath, [file, ...args], {
      encoding: 'utf8',
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout);
    throw error;
  }
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'aw-release-eval-chain-'));
try {
  const plugin = path.join(temp, 'demo-plugin');
  const sourceSkill = path.join(plugin, 'skills', 'demo');
  const finalRoot = path.join(temp, 'final');
  const finalSkill = path.join(finalRoot, 'demo');
  for (const skillRoot of [sourceSkill, finalSkill]) {
    await mkdir(path.join(skillRoot, 'agents'), { recursive: true });
    await writeFile(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: demo\ndescription: Perform one evaluated demo task.\n---\n\nReturn the supplied value.\n',
    );
    await writeFile(
      path.join(skillRoot, 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );
    await writeFile(path.join(skillRoot, 'README.md'), '# Demo Skill\n');
  }
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await writeFile(path.join(plugin, 'README.md'), '# Demo Plugin\n');
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'demo-plugin',
    version: '1.0.0',
    description: 'Demo plugin.',
    compatibility: { aw: { minVersion: '0.1.0' } },
    skills: './skills',
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
    },
  }));
  await mkdir(path.join(sourceSkill, 'evals'), { recursive: true });
  const evalCases = {
    schemaVersion: 1,
    skill: 'demo',
    cases: [{
      id: 'case_1',
      split: 'validation',
      query: 'Run the demo.',
      should_load_skill: true,
    }],
  };
  const casesPath = path.join(sourceSkill, 'evals', 'cases.json');
  await writeFile(casesPath, JSON.stringify(evalCases));
  const evalManifestPath = path.join(sourceSkill, 'evals', 'manifest.json');
  const evalManifest = {
    schemaVersion: 2,
    plugin: 'demo-plugin',
    skill: 'demo',
    profiles: [{
      id: 'project-default',
      scope: 'project',
      plugins: [{ name: 'demo-plugin', config: {} }],
      runModel: true,
      requiredForRelease: true,
    }],
    suites: [{
      id: 'release',
      kind: 'trigger',
      skills: ['demo'],
      cases: './cases.json',
      observeSpawnAgent: false,
      isolation: 'strict',
      strictNegativeSplits: [],
      profiles: ['project-default'],
      defaultRuns: 3,
      releaseSplits: ['validation'],
      requiredForRelease: true,
      perRunTimeoutMs: 180000,
    }],
  };
  await writeFile(evalManifestPath, JSON.stringify(evalManifest));

  const env = {
    ...process.env,
    AW_SKILL_VALIDATOR_BIN: skillValidatorBin,
    AW_PLUGIN_VALIDATOR_BIN: skillValidatorBin,
    AW_SKILL_CHECK_BIN: skillChecker,
    AW_REVIEW_LITE_VALIDATOR: reviewValidator,
    AW_EVAL_AUDIT_VALIDATOR: auditValidator,
    AW_EVAL_BUNDLE_VALIDATOR: bundleValidator,
  };
  const check = await runJson(skillChecker, [
    finalSkill,
    '--root-kind', 'materialized',
    '--profile', 'codex-project',
    '--format', 'json',
  ], env);
  assert.equal(check.ok, true);

  const reviewPath = path.join(temp, 'review.json');
  await writeFile(reviewPath, JSON.stringify({
    schemaVersion: 2,
    target: { name: 'demo', digest: check.target.digest },
    mode: 'full',
    design: 'pass',
    complexity: 'proportionate',
    summary: 'The evaluated Skill is focused and supported.',
    findings: [],
    unknowns: [],
    evalEvidence: 'none',
    dimensions: dimensions.map((id) => ({
      id,
      score: 4,
      confidence: 'medium',
      basis: `${id} is supported by the fixture evidence.`,
    })),
  }));

  const corpusDigest = sha256(stableJson(evalCases));
  const preflightPath = path.join(temp, 'preflight.json');
  const preflight = {
    schemaVersion: 3,
    producer: 'audit-agent-skill-evals',
    independentContext: true,
    auditId: 'preflight-1',
    mode: 'preflight',
    targetSkillDigest: check.target.digest,
    caseCorpusDigest: corpusDigest,
    runBundleDigest: null,
    validity: 'pass',
    optimizationPolicy: 'balanced',
    cases: [{
      caseId: 'case_1',
      releaseRelevant: true,
      admission: 'pass',
      oracleConfidence: 'high',
      findings: [],
    }],
    blockedCases: [],
    releaseEligible: true,
    failureTriage: [],
    recommendedAction: 'accepted-risk',
  };
  const preflightRaw = JSON.stringify(preflight);
  await writeFile(preflightPath, preflightRaw);

  const stdout = 'fixture stdout';
  const stderr = '';
  await mkdir(path.join(temp, 'runs'), { recursive: true });
  await writeFile(path.join(temp, 'runs', 'stdout.txt'), stdout);
  await writeFile(path.join(temp, 'runs', 'stderr.txt'), stderr);
  const bundlePath = path.join(temp, 'bundle.json');
  const bundle = {
    schemaVersion: 2,
    producer: 'run-agent-skill-evals',
    independentContext: false,
    provider: { id: 'fixture', version: '1' },
    planDigest: `sha256:${'3'.repeat(64)}`,
    targetSkillDigest: check.target.digest,
    caseCorpusDigest: corpusDigest,
    preflightAuditDigest: sha256(preflightRaw),
    comparisonPlanned: false,
    evidenceLevel: 'executed',
    runs: [1, 2, 3].map((runIndex) => ({
      caseId: 'case_1',
      configuration: 'with',
      comparisonId: null,
      skillMode: 'with-skill',
      skillDigest: check.target.digest,
      runIndex,
      status: 'completed',
      exitCode: 0,
      durationMs: 1,
      stdoutPath: 'runs/stdout.txt',
      stdoutDigest: sha256(stdout),
      stderrPath: 'runs/stderr.txt',
      stderrDigest: sha256(stderr),
      usage: null,
      grading: null,
      artifacts: [],
    })),
    aggregate: {
      cases: 1,
      configurations: 1,
      runs: 3,
      completed: 3,
      processFailed: 0,
      timedOut: 0,
      comparisons: [],
    },
    limitations: ['fixture evidence'],
  };
  const bundleRaw = JSON.stringify(bundle);
  await writeFile(bundlePath, bundleRaw);

  const triagePath = path.join(temp, 'triage.json');
  const triage = {
    ...preflight,
    auditId: 'triage-1',
    mode: 'result-triage',
    runBundleDigest: sha256(bundleRaw),
  };
  await writeFile(triagePath, JSON.stringify(triage));

  const args = [
    plugin,
    '--review', reviewPath,
    '--profile', 'codex-project',
    '--final', `codex-project=${finalRoot}`,
    '--preflight-audit', preflightPath,
    '--run-bundle', bundlePath,
    '--triage-audit', triagePath,
    '--format', 'json',
  ];
  const ready = await runJson(releaseChecker, args, env);
  assert.equal(ready.ready, true, JSON.stringify(ready.reasons));
  assert.equal(ready.schemaVersion, 2);
  assert.equal(ready.targets[0].evalEvidence.evidenceLevel, 'executed');

  await writeFile(casesPath, JSON.stringify({
    ...evalCases,
    cases: [{ ...evalCases.cases[0], query: 'Run the changed demo.' }],
  }));
  const staleCorpus = await runJson(releaseChecker, args, env);
  assert.equal(staleCorpus.ready, false);
  assert.ok(staleCorpus.reasons.some((reason) => reason.includes('current required suite corpus')));
  await writeFile(casesPath, JSON.stringify(evalCases));

  const partialBundle = {
    ...bundle,
    runs: bundle.runs.slice(0, 1),
    aggregate: { ...bundle.aggregate, runs: 1, completed: 1 },
  };
  const partialBundleRaw = JSON.stringify(partialBundle);
  await writeFile(bundlePath, partialBundleRaw);
  await writeFile(triagePath, JSON.stringify({
    ...triage,
    runBundleDigest: sha256(partialBundleRaw),
  }));
  const partialRuns = await runJson(releaseChecker, args, env);
  assert.equal(partialRuns.ready, false);
  assert.ok(partialRuns.reasons.some((reason) => reason.includes('case_1 (1/3)')));

  const baselineBundle = {
    ...bundle,
    runs: bundle.runs.map((run) => ({
      ...run,
      configuration: 'baseline',
      skillMode: 'without-skill',
      skillDigest: null,
    })),
  };
  const baselineBundleRaw = JSON.stringify(baselineBundle);
  await writeFile(bundlePath, baselineBundleRaw);
  await writeFile(triagePath, JSON.stringify({
    ...triage,
    runBundleDigest: sha256(baselineBundleRaw),
  }));
  const baselineOnly = await runJson(releaseChecker, args, env);
  assert.equal(baselineOnly.ready, false);
  assert.ok(baselineOnly.reasons.some((reason) => reason.includes('case_1 (0/3)')));

  await writeFile(bundlePath, bundleRaw);

  await writeFile(evalManifestPath, JSON.stringify({
    ...evalManifest,
    suites: [...evalManifest.suites, {
      id: 'workflow',
      kind: 'command',
      skills: ['demo'],
      entry: './run-workflow.mjs',
      profiles: ['project-default'],
      defaultRuns: 1,
      releaseSplits: [],
      requiredForRelease: true,
      perRunTimeoutMs: 180000,
      suiteTimeoutMs: 360000,
      supports: ['runs'],
    }],
  }));
  await writeFile(path.join(sourceSkill, 'evals', 'run-workflow.mjs'), '');
  await writeFile(triagePath, JSON.stringify(triage));
  const unsupportedSuite = await runJson(releaseChecker, args, env);
  assert.equal(unsupportedSuite.ready, false);
  assert.ok(unsupportedSuite.reasons.some((reason) => reason.includes('workflow')));
  await writeFile(evalManifestPath, JSON.stringify(evalManifest));

  await writeFile(triagePath, JSON.stringify({
    ...triage,
    runBundleDigest: `sha256:${'9'.repeat(64)}`,
  }));
  const blocked = await runJson(releaseChecker, args, env);
  assert.equal(blocked.ready, false);
  assert.ok(blocked.reasons.some((reason) => reason.includes('runBundleDigest')));
} finally {
  await rm(temp, { recursive: true, force: true });
}
