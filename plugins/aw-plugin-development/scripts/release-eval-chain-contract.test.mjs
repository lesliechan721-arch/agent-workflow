import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const skillValidatorBin = path.resolve(sourceRoot, '..', '..', 'packages', 'cli', 'dist', 'index.js');
const evalBin = path.resolve(sourceRoot, '..', '..', 'packages', 'agent-skill-eval', 'dist', 'bin.js');
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
  const publicBin = path.join(temp, 'public-bin');
  const publicAw = path.join(publicBin, 'aw');
  const publicEval = path.join(publicBin, 'aw-skill-eval');
  await mkdir(publicBin, { recursive: true });
  await writeFile(publicAw, `#!/bin/sh
if [ "$1" = "plugin" ]; then
  printf '%s\\n' '{"ok":true,"errors":[]}'
  exit 0
fi
exec "${process.execPath}" "${skillValidatorBin}" "$@"
`);
  await chmod(publicAw, 0o755);
  await writeFile(publicEval, `#!/bin/sh
exec "${process.execPath}" "${evalBin}" "$@"
`);
  await chmod(publicEval, 0o755);
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
    schemaVersion: 2,
    name: 'demo-plugin',
    version: '1.0.0',
    description: 'Demo plugin.',
    artifacts: {
      targets: [
        { id: 'demo-codex', target: 'codex.skill', skillKey: 'demo', scopes: ['project'], sourceDirs: ['./skills/demo'] },
        { id: 'demo-claude', target: 'claude.skill', skillKey: 'demo', scopes: ['project'], sourceDirs: ['./skills/demo'] },
      ],
    },
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX', 'CLAUDE'] },
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
  const evalCasesTwo = {
    schemaVersion: 1,
    skill: 'demo',
    cases: [{
      id: 'case_2',
      split: 'validation',
      query: 'Run the second demo.',
      should_load_skill: true,
    }],
  };
  const casesPathTwo = path.join(sourceSkill, 'evals', 'cases-two.json');
  await writeFile(casesPathTwo, JSON.stringify(evalCasesTwo));
  const evalManifestPath = path.join(sourceSkill, 'evals', 'manifest.json');
  const evalManifest = {
    schemaVersion: 1,
    plugin: 'demo-plugin',
    skill: 'demo',
    profiles: [{
      id: 'project-default',
      scope: 'project',
      plugins: [{ name: 'demo-plugin', config: {} }],
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
    }, {
      id: 'release-two',
      kind: 'trigger',
      skills: ['demo'],
      cases: './cases-two.json',
      observeSpawnAgent: false,
      isolation: 'strict',
      strictNegativeSplits: [],
      profiles: ['project-default'],
      defaultRuns: 2,
      releaseSplits: ['validation'],
      requiredForRelease: true,
      perRunTimeoutMs: 180000,
    }],
  };
  await writeFile(evalManifestPath, JSON.stringify(evalManifest));

  const env = {
    ...process.env,
    PATH: `${publicBin}${path.delimiter}${process.env.PATH ?? ''}`,
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
    schemaVersion: 1,
    target: { name: 'demo', digest: check.target.digest },
    mode: 'full',
    design: 'pass',
    complexity: 'proportionate',
    findings: [],
    unknowns: [],
    dimensions: dimensions.map((id) => ({
      id,
      score: 4,
      confidence: 'medium',
      basis: `${id} is supported by the fixture evidence.`,
    })),
  }));

  const capabilities = {
    schemaVersion: 2,
    provider: 'fixture',
    providerVersion: '1',
    capabilities: {
      triggerDiscovery: true,
      conversation: true,
      skillPathExecution: true,
      previousVersionBaseline: true,
      withoutSkillBaseline: true,
      cleanContext: true,
      parallelRuns: false,
      toolTrace: false,
      tokenUsage: false,
      duration: true,
      sandbox: false,
      materialization: true,
    },
    limitations: ['fixture evidence'],
  };
  const capabilitiesRaw = JSON.stringify(capabilities);
  const stdout = JSON.stringify({
    schemaVersion: 1,
    provider: { id: 'fixture', version: '1' },
    usage: null,
    grading: null,
    artifacts: [],
  });
  const stderr = '';
  async function writeChain({ suite, caseId, caseDocument, runs }) {
    const chainRoot = path.join(temp, `chain-${suite}`);
    const planPath = path.join(chainRoot, 'plan.json');
    const preflightPath = path.join(chainRoot, 'preflight.json');
    const bundlePath = path.join(chainRoot, 'bundle.json');
    const triagePath = path.join(chainRoot, 'triage.json');
    const corpusDigest = sha256(stableJson(caseDocument));
    await mkdir(path.join(chainRoot, 'runs'), { recursive: true });
    await cp(finalSkill, path.join(chainRoot, 'target'), { recursive: true });
    await writeFile(path.join(chainRoot, 'cases.json'), JSON.stringify(caseDocument));
    await writeFile(path.join(chainRoot, 'capabilities.json'), capabilitiesRaw);
    await writeFile(path.join(chainRoot, 'runs', 'stdout.txt'), stdout);
    await writeFile(path.join(chainRoot, 'runs', 'stderr.txt'), stderr);
    const plan = {
      schemaVersion: 4,
      planId: `release-eval-${suite}`,
      target: {
        name: 'demo',
        path: 'target',
        digest: check.target.digest,
      },
      cases: { paths: ['cases.json'], corpusDigest },
      provider: {
        id: 'fixture',
        command: ['fixture-provider'],
        describeCommand: ['fixture-provider', '--describe'],
        cwd: null,
        env: {},
        capabilitiesPath: 'capabilities.json',
        capabilitiesDigest: sha256(capabilitiesRaw),
        inheritEnvironment: false,
      },
      runtimeInputs: [],
      configurations: [{ id: 'with', skillMode: 'with-skill', comparisonId: null, env: {} }],
      runsPerCase: runs,
      timeoutMs: 180000,
      outputRoot: 'eval-output',
      capture: { outputs: true, trace: false, timing: true, usage: false },
    };
    const planRaw = JSON.stringify(plan);
    await writeFile(planPath, planRaw);
    await writeFile(path.join(chainRoot, 'preparation.json'), JSON.stringify({
      schemaVersion: 1,
      command: 'skill:eval:prepare',
      plugin: 'demo-plugin',
      skill: 'demo',
      suite,
      profile: 'project-default',
      planPath: 'plan.json',
      targetDigest: check.target.digest,
      corpusDigest,
    }));
    const preflight = {
      schemaVersion: 3,
      producer: 'audit-agent-skill-evals',
      independentContext: true,
      auditId: `preflight-${suite}`,
      mode: 'preflight',
      targetSkillDigest: check.target.digest,
      caseCorpusDigest: corpusDigest,
      runBundleDigest: null,
      validity: 'pass',
      optimizationPolicy: 'balanced',
      cases: [{ caseId, releaseRelevant: true, admission: 'pass', oracleConfidence: 'high', findings: [] }],
      blockedCases: [],
      releaseEligible: true,
      failureTriage: [],
      recommendedAction: 'accepted-risk',
    };
    await writeFile(preflightPath, JSON.stringify(preflight));
    const bundle = {
      schemaVersion: 4,
      runner: { id: 'aw-skill-eval', version: '0.1.0' },
      independentContext: false,
      provider: { id: 'fixture', version: '1' },
      providerCapabilitiesDigest: `sha256:${'4'.repeat(64)}`,
      planDigest: sha256(planRaw),
      targetSkillDigest: check.target.digest,
      caseCorpusDigest: corpusDigest,
      runtimeInputs: [],
      comparisonPlanned: false,
      evidenceLevel: 'executed',
      runs: Array.from({ length: runs }, (_, index) => ({
        caseId,
        configuration: 'with',
        comparisonId: null,
        skillMode: 'with-skill',
        skillDigest: check.target.digest,
        runIndex: index + 1,
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
        runs,
        completed: runs,
        processFailed: 0,
        timedOut: 0,
        comparisons: [],
      },
      limitations: ['fixture evidence'],
    };
    const bundleRaw = JSON.stringify(bundle);
    await writeFile(bundlePath, bundleRaw);
    const triage = {
      ...preflight,
      auditId: `triage-${suite}`,
      mode: 'result-triage',
      runBundleDigest: sha256(bundleRaw),
    };
    await writeFile(triagePath, JSON.stringify(triage));
    return { planPath, preflightPath, bundlePath, triagePath, plan, planRaw, preflight, bundle, bundleRaw, triage };
  }

  const chainOne = await writeChain({
    suite: 'release', caseId: 'case_1', caseDocument: evalCases, runs: 3,
  });
  const chainTwo = await writeChain({
    suite: 'release-two', caseId: 'case_2', caseDocument: evalCasesTwo, runs: 2,
  });
  const { planPath, preflightPath, bundlePath, triagePath, preflight, bundle, bundleRaw, triage } = chainOne;

  const args = [
    plugin,
    '--workspace-root', temp,
    '--review', reviewPath,
    '--profile', 'codex-project',
    '--final', `codex-project=${finalRoot}`,
    '--eval-plan', planPath,
    '--eval-plan', chainTwo.planPath,
    '--preflight-audit', preflightPath,
    '--preflight-audit', chainTwo.preflightPath,
    '--run-bundle', bundlePath,
    '--run-bundle', chainTwo.bundlePath,
    '--triage-audit', triagePath,
    '--triage-audit', chainTwo.triagePath,
    '--format', 'json',
  ];
  const ready = await runJson(releaseChecker, args, env);
  assert.equal(ready.ready, true, JSON.stringify(ready.reasons));
  assert.equal(ready.schemaVersion, 2);
  assert.equal(ready.targets[0].evalEvidence.evidenceLevel, 'executed');
  assert.equal(ready.targets[0].evalEvidence.chains.length, 2);
  assert.equal(ready.targets[0].dynamicTargetId, 'demo-codex');

  const missingSecondChain = await runJson(releaseChecker, [
    plugin,
    '--workspace-root', temp,
    '--review', reviewPath,
    '--profile', 'codex-project',
    '--final', `codex-project=${finalRoot}`,
    '--eval-plan', planPath,
    '--preflight-audit', preflightPath,
    '--run-bundle', bundlePath,
    '--triage-audit', triagePath,
    '--format', 'json',
  ], env);
  assert.equal(missingSecondChain.ready, false);
  assert.ok(missingSecondChain.reasons.some((reason) =>
    reason.includes('missing complete Eval chain project-default/release-two')));

  const crossBundleCannotSubstitute = await runJson(releaseChecker, [
    plugin,
    '--workspace-root', temp,
    '--review', reviewPath,
    '--profile', 'codex-project',
    '--final', `codex-project=${finalRoot}`,
    '--eval-plan', planPath,
    '--eval-plan', chainTwo.planPath,
    '--preflight-audit', preflightPath,
    '--preflight-audit', chainTwo.preflightPath,
    '--run-bundle', bundlePath,
    '--triage-audit', triagePath,
    '--format', 'json',
  ], env);
  assert.equal(crossBundleCannotSubstitute.ready, false);
  assert.ok(crossBundleCannotSubstitute.reasons.some((reason) =>
    reason.includes('missing complete Eval chain project-default/release-two')));

  const duplicateChain = await runJson(releaseChecker, [
    ...args.slice(0, -2),
    '--eval-plan', planPath,
    '--format', 'json',
  ], env);
  assert.equal(duplicateChain.ready, false);
  assert.ok(duplicateChain.reasons.some((reason) => reason.includes('duplicate Eval plan for Eval chain')));

  const claudeReady = await runJson(releaseChecker, [
    ...args.map((entry) => entry === 'codex-project'
      ? 'claude-project'
      : entry.replace(/^codex-project=/u, 'claude-project=')),
  ], env);
  assert.equal(claudeReady.ready, true, JSON.stringify(claudeReady.reasons));
  assert.equal(claudeReady.targets[0].dynamicTargetId, 'demo-claude');

  const missingEvidence = await runJson(releaseChecker, [
    plugin,
    '--workspace-root', temp,
    '--review', reviewPath,
    '--profile', 'codex-project',
    '--final', `codex-project=${finalRoot}`,
    '--format', 'json',
  ], env);
  assert.equal(missingEvidence.ready, false);
  assert.ok(missingEvidence.reasons.some((reason) => reason.includes('missing complete Eval chain')));

  await rm(evalManifestPath);
  const missingManifest = await runJson(releaseChecker, args, env);
  assert.equal(missingManifest.ready, false);
  assert.ok(missingManifest.reasons.some((reason) => reason.includes('requires evals/manifest.json bound by skillKey')));
  await writeFile(evalManifestPath, JSON.stringify(evalManifest));

  await writeFile(evalManifestPath, JSON.stringify({
    ...evalManifest,
    profiles: evalManifest.profiles.map((profile) => ({
      ...profile,
      requiredForRelease: false,
    })),
    suites: evalManifest.suites.map((suite) => ({
      ...suite,
      requiredForRelease: false,
    })),
  }));
  const noReleaseSuite = await runJson(releaseChecker, args, env);
  assert.equal(noReleaseSuite.ready, false);
  assert.ok(noReleaseSuite.reasons.some((reason) =>
    reason.includes('at least one release-required Eval suite')));
  await writeFile(evalManifestPath, JSON.stringify(evalManifest));

  await writeFile(casesPath, JSON.stringify({
    ...evalCases,
    cases: [{ ...evalCases.cases[0], query: 'Run the changed demo.' }],
  }));
  const staleCorpus = await runJson(releaseChecker, args, env);
  assert.equal(staleCorpus.ready, false);
  assert.ok(staleCorpus.reasons.some((reason) => reason.includes('case corpus does not match')));
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
  assert.ok(blocked.reasons.some((reason) => reason.includes('missing complete Eval chain project-default/release')));
} finally {
  await rm(temp, { recursive: true, force: true });
}
