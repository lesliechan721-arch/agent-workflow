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

function computeEvalProviderDigest(provider) {
  assert.equal(provider, 'codex-conversation');
  return sha256(JSON.stringify(provider));
}

function emptyWorkspaceDigest() {
  const domain = Buffer.from('aw-eval-workspace-records-v1', 'utf8');
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(domain.length));
  return `sha256:${createHash('sha256').update(length).update(domain).digest('hex')}`;
}

function resultSummary(runs) {
  const summary = { passed: 0, failed: 0, timeout: 0, error: 0 };
  for (const run of runs) {
    if (run.status === 'timeout') summary.timeout += 1;
    else if (run.status === 'failed') summary.error += 1;
    else if (run.grade?.passed) summary.passed += 1;
    else summary.failed += 1;
  }
  return summary;
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

const temp = await mkdtemp(path.join(os.tmpdir(), 'aw-release-eval-chain-v1-'));
try {
  const publicBin = path.join(temp, 'public-bin');
  await mkdir(publicBin, { recursive: true });
  await writeFile(path.join(publicBin, 'aw'), `#!/bin/sh
if [ "$1" = "plugin" ]; then
  printf '%s\\n' '{"ok":true,"errors":[]}'
  exit 0
fi
exec "${process.execPath}" "${skillValidatorBin}" "$@"
`);
  await chmod(path.join(publicBin, 'aw'), 0o755);
  await writeFile(path.join(publicBin, 'aw-skill-eval'), `#!/bin/sh
exec "${process.execPath}" "${evalBin}" "$@"
`);
  await chmod(path.join(publicBin, 'aw-skill-eval'), 0o755);
  const env = {
    ...process.env,
    PATH: `${publicBin}${path.delimiter}${process.env.PATH ?? ''}`,
  };

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
    schemaVersion: 3,
    name: 'demo-plugin',
    version: '1.0.0',
    description: 'Demo plugin.',
    artifacts: {
      targets: [{
        id: 'demo-codex',
        platform: 'codex',
        target: 'codex.skill',
        delivery: { mode: 'aw-extension' },
        skillKey: 'demo',
        scopes: ['project'],
        states: ['present'],
        refreshKeys: [],
        sourceDirs: ['./skills/demo'],
      }],
    },
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
    },
  }));

  const selectedCases = {
    version: 1,
    suite: {
      kind: 'conversation',
      unitUnderTest: 'demo',
      runtime: { isolation: 'strict' },
    },
    cases: [{
      id: 'case_release',
      split: 'release',
      tags: [],
      prompt: 'Run the release demo.',
      assertions: ['Returns the supplied value.'],
    }, {
      id: 'case_train',
      split: 'train',
      tags: [],
      prompt: 'Run the training demo.',
      assertions: ['Returns the training value.'],
    }],
  };
  const evalRoot = path.join(sourceSkill, 'evals');
  await mkdir(evalRoot, { recursive: true });
  const casesPath = path.join(evalRoot, 'cases.json');
  const manifestPath = path.join(evalRoot, 'manifest.json');
  await writeFile(casesPath, JSON.stringify(selectedCases));
  const evalManifest = {
    version: 1,
    defaults: { profile: 'project-default', runs: 2, timeoutMs: 1_000 },
    profiles: {
      'project-default': { scope: 'project', plugins: { 'demo-plugin': {} } },
    },
    suites: [{
      id: 'release',
      kind: 'conversation',
      cases: 'cases.json',
      requiredForRelease: true,
      releaseSplits: [],
    }],
  };
  await writeFile(manifestPath, JSON.stringify(evalManifest));

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

  let chainSequence = 0;
  async function writeChain(options = {}) {
    chainSequence += 1;
    const root = path.join(temp, `chain-${chainSequence}`);
    await mkdir(path.join(root, 'workspace'), { recursive: true });
    await cp(finalSkill, path.join(root, 'target'), { recursive: true });
    const cases = structuredClone(options.cases ?? selectedCases);
    const casesRaw = JSON.stringify(cases);
    await writeFile(path.join(root, 'cases.json'), casesRaw);
    const baseline = structuredClone(options.baseline ?? { type: 'none' });
    if (baseline.type === 'previous-version') {
      await cp(finalSkill, path.join(root, 'previous'), { recursive: true });
      await writeFile(
        path.join(root, 'previous', 'SKILL.md'),
        '---\nname: demo\ndescription: Previous evaluated demo task.\n---\n\nReturn the previous value.\n',
      );
      const previous = await runJson(skillChecker, [
        path.join(root, 'previous'),
        '--root-kind', 'materialized',
        '--profile', 'codex-project',
        '--format', 'json',
      ], env);
      baseline.target = { path: 'previous', digest: previous.target.digest };
    }
    const spec = {
      version: 1,
      source: {
        plugin: options.plugin ?? 'demo-plugin',
        skill: options.skill ?? 'demo',
        suite: options.suite ?? 'release',
        profile: options.profile ?? 'project-default',
      },
      workspace: {
        path: 'workspace',
        digest: emptyWorkspaceDigest(),
      },
      target: { path: 'target', digest: check.target.digest },
      cases: { path: 'cases.json', digest: sha256(casesRaw) },
      provider: 'codex-conversation',
      runs: 2,
      timeoutMs: 1_000,
      baseline,
      outputDir: 'output',
    };
    const specRaw = JSON.stringify(spec);
    const specPath = path.join(root, 'spec.json');
    await writeFile(specPath, specRaw);

    const targets = [{ role: 'current', digest: check.target.digest }];
    if (baseline.type === 'previous-version') {
      targets.push({ role: 'previous-version', digest: baseline.target.digest });
    }
    if (options.auditTargetMismatch) targets[0].digest = spec.cases.digest;
    const audit = {
      version: 1,
      workspaceDigest: spec.workspace.digest,
      providerDigest: computeEvalProviderDigest(spec.provider),
      targets,
      caseDigest: spec.cases.digest,
      status: options.auditStatus ?? 'pass',
      approvedCaseIds: cases.cases.map((entry) => entry.id),
      blockedCases: options.blockedCases ?? [],
      issues: [],
    };
    const auditRaw = JSON.stringify(audit);
    const auditPath = path.join(root, 'audit.json');
    await writeFile(auditPath, auditRaw);

    const runs = [];
    const baselineVariant = baseline.type === 'previous-version'
      ? 'previous-version'
      : baseline.type === 'without-skill' ? 'without-skill' : null;
    for (const evalCase of cases.cases) {
      const currentCount = options.currentRuns?.[evalCase.id] ?? 2;
      for (let attempt = 1; attempt <= currentCount; attempt += 1) {
        const passed = options.currentPassed?.[evalCase.id]?.[attempt - 1] ?? true;
        const score = options.currentScores?.[evalCase.id]?.[attempt - 1] ?? (passed ? 1 : 0);
        runs.push({
          caseId: evalCase.id,
          variant: 'current',
          attempt,
          status: 'completed',
          durationMs: 1,
          outputDir: `output/${evalCase.id}/current/${attempt}`,
          usage: null,
          grade: { passed, score },
          error: null,
        });
      }
      if (baselineVariant) {
        const baselineCount = options.baselineRuns?.[evalCase.id] ?? 2;
        for (let attempt = 1; attempt <= baselineCount; attempt += 1) {
          const passed = options.baselinePassed?.[evalCase.id]?.[attempt - 1] ?? true;
          const score = options.baselineScores?.[evalCase.id]?.[attempt - 1] ?? (passed ? 1 : 0);
          runs.push({
            caseId: evalCase.id,
            variant: baselineVariant,
            attempt,
            status: 'completed',
            durationMs: 1,
            outputDir: `output/${evalCase.id}/${baselineVariant}/${attempt}`,
            usage: null,
            grade: { passed, score },
            error: null,
          });
        }
      }
    }
    const result = {
      version: 2,
      specDigest: sha256(specRaw),
      auditDigest: sha256(auditRaw),
      targetDigest: check.target.digest,
      caseDigest: spec.cases.digest,
      provider: spec.provider,
      processManagement: options.processManagement ?? {
        mode: 'managed',
        inspectionAvailable: true,
        userAcknowledged: false,
        descendantCleanupGuaranteed: false,
        limitation: 'Process-tree inspection is not OS-enforced containment.',
      },
      startedAt: '2026-08-31T00:00:00Z',
      finishedAt: '2026-08-31T00:00:01Z',
      runs,
      summary: options.summary ?? resultSummary(runs),
    };
    const resultPath = path.join(root, 'result.json');
    await writeFile(resultPath, JSON.stringify(result));
    return { root, specPath, auditPath, resultPath };
  }

  function checkerArgs(chain, extra = []) {
    return [
      plugin,
      '--workspace-root', temp,
      '--review', reviewPath,
      '--profile', 'codex-project',
      '--final', `codex-project=${finalRoot}`,
      '--eval-spec', chain.specPath,
      '--eval-audit', chain.auditPath,
      '--eval-result', chain.resultPath,
      ...extra,
      '--format', 'json',
    ];
  }

  const valid = await writeChain();
  const validResult = await runJson(releaseChecker, checkerArgs(valid), env);
  assert.equal(validResult.ready, true);
  assert.equal(validResult.targets.find((entry) => entry.kind === 'materialized').evalEvidence.valid, true);
  assert.equal(JSON.stringify(validResult).includes('triage'), false);
  assert.equal(JSON.stringify(validResult).includes('evidenceLevel'), false);

  const omittedSplitsManifest = structuredClone(evalManifest);
  delete omittedSplitsManifest.suites[0].releaseSplits;
  await writeFile(manifestPath, JSON.stringify(omittedSplitsManifest));
  assert.equal((await runJson(releaseChecker, checkerArgs(valid), env)).ready, true);
  await writeFile(manifestPath, JSON.stringify(evalManifest));

  const unmanaged = await writeChain({
    processManagement: {
      mode: 'unmanaged-confirmed',
      inspectionAvailable: false,
      userAcknowledged: true,
      descendantCleanupGuaranteed: false,
      limitation: 'Only the direct child is targeted.',
    },
  });
  const unmanagedDefaultResult = await runJson(releaseChecker, checkerArgs(unmanaged), env);
  assert.equal(unmanagedDefaultResult.ready, false);
  assert.ok(unmanagedDefaultResult.reasons.some((reason) => reason.includes('managed-only release policy')));
  const unmanagedAllowedManifest = structuredClone(evalManifest);
  unmanagedAllowedManifest.suites[0].releaseProcessManagement = 'allow-unmanaged-confirmed';
  await writeFile(manifestPath, JSON.stringify(unmanagedAllowedManifest));
  assert.equal((await runJson(releaseChecker, checkerArgs(unmanaged), env)).ready, true);
  await writeFile(manifestPath, JSON.stringify(evalManifest));

  const missingAuditArgs = checkerArgs(valid).filter((value, index, values) => (
    value !== '--eval-audit' && values[index - 1] !== '--eval-audit'
  ));
  const missingAudit = await runJson(releaseChecker, missingAuditArgs, env);
  assert.equal(missingAudit.ready, false);
  assert.ok(missingAudit.reasons.some((reason) => reason.includes('EvalSpec/EvalAudit/EvalResult')));

  for (const chain of [
    await writeChain({ auditTargetMismatch: true }),
    await writeChain({ auditStatus: 'fail' }),
    await writeChain({ blockedCases: [{ caseId: 'case_release', reason: 'blocked fixture' }] }),
  ]) {
    const result = await runJson(releaseChecker, checkerArgs(chain), env);
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some((reason) => reason.includes('EvalAudit is invalid')));
  }

  const changedContent = structuredClone(selectedCases);
  changedContent.cases[0].prompt = 'Changed after the manifest corpus was selected.';
  const changedId = structuredClone(selectedCases);
  changedId.cases[0].id = 'foreign_case';
  for (const chain of [await writeChain({ cases: changedContent }), await writeChain({ cases: changedId })]) {
    const result = await runJson(releaseChecker, checkerArgs(chain), env);
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some((reason) => reason.includes('cases content and case IDs')));
  }

  const insufficient = await writeChain({ currentRuns: { case_release: 1 } });
  const insufficientResult = await runJson(releaseChecker, checkerArgs(insufficient), env);
  assert.equal(insufficientResult.ready, false);
  assert.ok(insufficientResult.reasons.some((reason) => reason.includes('lacks current runs')));

  const gradeFail = await writeChain({ currentPassed: { case_release: [true, false] } });
  const gradeFailResult = await runJson(releaseChecker, checkerArgs(gradeFail), env);
  assert.equal(gradeFailResult.ready, false);
  assert.ok(gradeFailResult.reasons.some((reason) => reason.includes('below minimumPassRate')));

  const relaxedCases = structuredClone(selectedCases);
  relaxedCases.suite.runtime.minimumPassRate = 0.5;
  await writeFile(casesPath, JSON.stringify(relaxedCases));
  const relaxedGrade = await writeChain({
    cases: relaxedCases,
    currentPassed: { case_release: [true, false] },
  });
  assert.equal((await runJson(releaseChecker, checkerArgs(relaxedGrade), env)).ready, true);
  await writeFile(casesPath, JSON.stringify(selectedCases));

  const badSummary = await writeChain({ summary: { passed: 0, failed: 0, timeout: 0, error: 0 } });
  const badSummaryResult = await runJson(releaseChecker, checkerArgs(badSummary), env);
  assert.equal(badSummaryResult.ready, false);
  assert.ok(badSummaryResult.reasons.some((reason) => reason.includes('summary')));

  for (const chain of [
    await writeChain({
      baseline: { type: 'without-skill' },
      currentPassed: { case_release: [true, false] },
    }),
    await writeChain({
      baseline: { type: 'previous-version' },
      currentScores: { case_release: [0.4, 0.4], case_train: [0.4, 0.4] },
      baselineScores: { case_release: [0.8, 0.8], case_train: [0.8, 0.8] },
    }),
  ]) {
    const result = await runJson(releaseChecker, checkerArgs(chain), env);
    assert.equal(result.ready, false);
    assert.ok(result.reasons.some((reason) => reason.includes('regresses')));
  }

  const foreign = await writeChain({ suite: 'foreign-suite' });
  const foreignResult = await runJson(releaseChecker, checkerArgs(valid, [
    '--eval-spec', foreign.specPath,
    '--eval-audit', foreign.auditPath,
    '--eval-result', foreign.resultPath,
  ]), env);
  assert.equal(foreignResult.ready, false);
  for (const label of ['EvalSpec', 'EvalAudit', 'EvalResult']) {
    assert.ok(foreignResult.reasons.some((reason) => (
      reason.includes(label) && reason.includes('is not consumed')
    )));
  }

  for (const flag of ['--eval-plan', '--preflight-audit', '--run-bundle', '--triage-audit']) {
    await assert.rejects(execFileAsync(process.execPath, [
      releaseChecker,
      plugin,
      '--workspace-root', temp,
      flag, valid.specPath,
    ], { encoding: 'utf8', env }), /Unknown option/u);
  }

  process.stdout.write('AW release EvalSpec/Audit/Result contracts passed\n');
} finally {
  await rm(temp, { recursive: true, force: true });
}
