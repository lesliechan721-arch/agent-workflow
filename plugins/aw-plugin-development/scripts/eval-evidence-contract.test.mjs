import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const execFileAsync = promisify(execFile);
const localPluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginContext = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const runtimeRoot = pluginContext?.platform
  ? path.join(localPluginRoot, pluginContext.platform)
  : localPluginRoot;
const reviewScripts = path.join(runtimeRoot, 'skills', 'review-aw-plugin', 'scripts');
const temporaryRoots = [];

after(async () =>
  Promise.all(temporaryRoots.map((entry) => rm(entry, { recursive: true, force: true }))),
);

function sha256(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

async function run(script, args = [], cwd = runtimeRoot) {
  return execFileAsync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'aw-eval-evidence-'));
  temporaryRoots.push(root);
  const workspace = path.join(root, 'external-workspace');
  const target = path.join(workspace, 'packages', 'demo-plugin'),
    evidenceRoot = path.join(workspace, '.tmp', 'evidence');
  await mkdir(path.join(target, '.agents-plugin'), { recursive: true });
  await writeFile(
    path.join(target, '.agents-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'demo-plugin',
      version: '0.1.0',
      marketplace: { policy: { products: ['CODEX'] } },
    }),
    'utf8',
  );

  const casePath = path.join(evidenceRoot, 'cases.json');
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(casePath, JSON.stringify({ cases: [{ id: 'case-1', query: 'review' }] }), 'utf8');
  const corpusDigest = (
    await run(path.join(reviewScripts, 'validate-eval-audit-result.mjs'), [
      '--digest-only',
      '--case',
      casePath,
    ])
  ).stdout.trim();
  const targetSkillDigest = `sha256:${'1'.repeat(64)}`;
  const audit = {
    schemaVersion: 3,
    producer: 'audit-agent-skill-evals',
    independentContext: true,
    auditId: 'audit-1',
    mode: 'preflight',
    targetSkillDigest,
    caseCorpusDigest: corpusDigest,
    runBundleDigest: null,
    validity: 'pass',
    optimizationPolicy: 'balanced',
    cases: [
      {
        caseId: 'case-1',
        releaseRelevant: true,
        admission: 'pass',
        oracleConfidence: 'high',
        findings: [],
      },
    ],
    blockedCases: [],
    releaseEligible: true,
    failureTriage: [],
    recommendedAction: 'accepted-risk',
  };
  const auditPath = path.join(evidenceRoot, 'audit.json');
  const auditRaw = JSON.stringify(audit);
  await writeFile(auditPath, auditRaw, 'utf8');
  const stdoutPath = path.join(evidenceRoot, 'runs', 'case-1', 'with', '1', 'stdout.txt');
  const stderrPath = path.join(evidenceRoot, 'runs', 'case-1', 'with', '1', 'stderr.txt');
  const stdout = 'fixture stdout';
  const stderr = 'fixture stderr';
  await mkdir(path.dirname(stdoutPath), { recursive: true });
  await Promise.all([
    writeFile(stdoutPath, stdout, 'utf8'),
    writeFile(stderrPath, stderr, 'utf8'),
  ]);
  const result = {
    schemaVersion: 3,
    runner: { id: 'fixture-eval-runner', version: '9.0.0' },
    independentContext: false,
    provider: { id: 'command', version: 'test' },
    planDigest: `sha256:${'2'.repeat(64)}`,
    targetSkillDigest,
    caseCorpusDigest: corpusDigest,
    comparisonPlanned: false,
    evidenceLevel: 'executed',
    runs: [
      {
        caseId: 'case-1',
        configuration: 'with',
        comparisonId: null,
        skillMode: 'with-skill',
        skillDigest: targetSkillDigest,
        runIndex: 1,
        status: 'completed',
        exitCode: 0,
        durationMs: 1,
        stdoutPath: 'runs/case-1/with/1/stdout.txt',
        stdoutDigest: sha256(stdout),
        stderrPath: 'runs/case-1/with/1/stderr.txt',
        stderrDigest: sha256(stderr),
        usage: null,
        grading: null,
        artifacts: [],
      },
    ],
    aggregate: {
      cases: 1,
      configurations: 1,
      runs: 1,
      completed: 1,
      processFailed: 0,
      timedOut: 0,
      comparisons: [],
    },
    limitations: ['fixture'],
  };
  const resultPath = path.join(evidenceRoot, 'eval-run-bundle.json');
  await writeFile(resultPath, JSON.stringify(result), 'utf8');
  return { root, workspace, target, casePath, auditPath, resultPath, result, stdoutPath };
}

test('AW bundle binds Eval execution to preflight target and corpus and keeps external workspace identity', async () => {
  const value = await fixture();
  const prepare = path.join(reviewScripts, 'prepare-aw-review-bundle.mjs');
  const prepared = await run(prepare, [
    value.target,
    '--repo-root',
    value.workspace,
    '--eval-audit',
    value.auditPath,
    '--eval-case',
    value.casePath,
    '--eval-result',
    value.resultPath,
  ]);
  const bundle = JSON.parse(prepared.stdout);
  assert.equal(bundle.environment.repository, 'external-workspace');
  const execution = bundle.orchestration.providedStages.find(
    (entry) => entry.id === 'eval-execution',
  );
  assert.equal(execution.independentContext, false);
  assert.equal(execution.producer, 'fixture-eval-runner');
  assert.equal(execution.subjectDigest, value.result.targetSkillDigest);

  const bundlePath = path.join(value.root, 'bundle.json');
  await writeFile(bundlePath, prepared.stdout, 'utf8');
  const validation = JSON.parse(
    (
      await run(path.join(reviewScripts, 'validate-review-input-bundle.mjs'), [
        bundlePath,
        '--handoff-root',
        value.root,
        '--format',
        'json',
      ])
    ).stdout,
  );
  assert.equal(validation.valid, true);

  await writeFile(value.stdoutPath, 'damaged', 'utf8');
  await assert.rejects(
    run(path.join(reviewScripts, 'validate-review-input-bundle.mjs'), [
      bundlePath,
      '--handoff-root',
      value.root,
    ]),
    /Command failed/u,
  );
});

test('AW bundle rejects Eval result without an audit or with a different corpus binding', async () => {
  const value = await fixture();
  const prepare = path.join(reviewScripts, 'prepare-aw-review-bundle.mjs');
  await assert.rejects(
    run(prepare, [value.target, '--repo-root', value.workspace, '--eval-result', value.resultPath]),
    /Command failed/u,
  );

  value.result.caseCorpusDigest = `sha256:${'3'.repeat(64)}`;
  await writeFile(value.resultPath, JSON.stringify(value.result), 'utf8');
  await assert.rejects(
    run(prepare, [
      value.target,
      '--repo-root',
      value.workspace,
      '--eval-audit',
      value.auditPath,
      '--eval-case',
      value.casePath,
      '--eval-result',
      value.resultPath,
    ]),
    /Command failed/u,
  );
});

test('AW bundle accepts one Eval result and rejects a second result for the same target', async () => {
  const value = await fixture();
  const prepare = path.join(reviewScripts, 'prepare-aw-review-bundle.mjs');
  const args = [
    value.target,
    '--repo-root',
    value.workspace,
    '--eval-audit',
    value.auditPath,
    '--eval-case',
    value.casePath,
    '--eval-result',
    value.resultPath,
  ];
  const prepared = JSON.parse((await run(prepare, args)).stdout);
  assert.equal(prepared.evalResults.length, 1);
  assert.equal(
    prepared.orchestration.providedStages.filter((stage) => stage.id === 'eval-execution').length,
    1,
  );

  await assert.rejects(
    run(prepare, [...args, '--eval-result', value.resultPath]),
    (error) => {
      assert.match(
        error.stderr,
        /ReviewInputBundle v5 accepts only one Eval execution bundle per target; provide --eval-result only once\./u,
      );
      return true;
    },
  );
});
