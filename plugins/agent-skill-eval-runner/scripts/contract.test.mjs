import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginContext = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = pluginContext?.sourceRoot ?? root;
const runtimeRoot = pluginContext?.platform ? path.join(root, pluginContext.platform) : root;
const runtimeSkillRoot = path.join(runtimeRoot, 'skills', 'run-agent-skill-evals');
const temporaryRoots = [];
after(async () =>
  Promise.all(temporaryRoots.map((entry) => rm(entry, { recursive: true, force: true }))),
);
function sha256(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
async function run(relative, args = []) {
  return execFileAsync(process.execPath, [path.join(runtimeSkillRoot, relative), ...args], {
    cwd: runtimeSkillRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}
async function createFixture({
  unsafeCaseId = false,
  outputRoot = './out',
  providerMutatesSkill = false,
  emptyCases = false,
  blockedAudit = false,
  malformedAuditCase = false,
  omitBaselineGrading = false,
  failingCaseId = null,
  secondCase = false,
} = {}) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'eval-runner-'));
  temporaryRoots.push(temporaryRoot);
  const skillRoot = path.join(temporaryRoot, 'skill');
  await mkdir(skillRoot);
  const skillContent = '---\nname: skill\ndescription: fixture\n---\n';
  await writeFile(path.join(skillRoot, 'SKILL.md'), skillContent, 'utf8');
  const targetDigest = sha256(
    Buffer.concat([Buffer.from('SKILL.md\0'), Buffer.from(skillContent), Buffer.from('\0')]),
  );
  const casesDocument = {
    cases: emptyCases
      ? []
      : [
          { id: unsafeCaseId ? '../escape' : 'c1', query: 'hello' },
          ...(secondCase ? [{ id: 'c2', query: 'hello again' }] : []),
        ],
  };
  const casePath = path.join(temporaryRoot, 'cases.json');
  await writeFile(casePath, JSON.stringify(casesDocument), 'utf8');
  const caseCorpusDigest = sha256(stable(casesDocument));
  const audit = {
    schemaVersion: 2,
    producer: 'audit-agent-skill-evals',
    independentContext: true,
    auditId: 'audit-1',
    mode: 'preflight',
    targetSkillDigest: targetDigest,
    caseCorpusDigest,
    validity: 'pass',
    optimizationPolicy: 'balanced',
    cases: malformedAuditCase
      ? [{}]
      : casesDocument.cases.map((entry) => ({
          caseId: entry.id,
          releaseRelevant: true,
          admission: 'pass',
          oracleConfidence: 'high',
          findings: [],
        })),
    blockedCases: blockedAudit ? ['c1'] : [],
    releaseEligible: true,
    failureTriage: [],
    recommendedAction: 'accepted-risk',
  };
  const auditPath = path.join(temporaryRoot, 'audit.json');
  const auditRaw = JSON.stringify(audit);
  await writeFile(auditPath, auditRaw, 'utf8');
  const providerPath = path.join(temporaryRoot, 'provider.mjs');
  await writeFile(
    providerPath,
    [
      "import { writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      providerMutatesSkill
        ? "if (process.env.AGENT_EVAL_SKILL_PATH) writeFileSync(path.join(process.env.AGENT_EVAL_SKILL_PATH, 'provider-mutation.txt'), 'snapshot only');"
        : '',
      "const trace = path.join(process.env.AGENT_EVAL_OUTPUT_DIR, 'trace.json');",
      'writeFileSync(trace, JSON.stringify({ ok: true }));',
      failingCaseId
        ? `if (process.env.AGENT_EVAL_CASE_ID === ${JSON.stringify(failingCaseId)}) process.exit(2);`
        : '',
      omitBaselineGrading
        ? "const grading = process.env.AGENT_EVAL_SKILL_MODE === 'with-skill' ? { grader: { id: 'fixture', version: '1' }, result: { passed: true } } : null;"
        : "const grading = { grader: { id: 'fixture', version: '1' }, result: { passed: true } };",
      "process.stdout.write(JSON.stringify({ grading, artifacts: [{ role: 'trace', path: trace }] }));",
    ].join('\n'),
    'utf8',
  );
  const capabilities = {
    schemaVersion: 1,
    provider: 'command',
    providerVersion: 'test',
    capabilities: {
      triggerDiscovery: false,
      skillPathExecution: true,
      previousVersionBaseline: true,
      withoutSkillBaseline: true,
      cleanContext: false,
      parallelRuns: false,
      toolTrace: false,
      tokenUsage: false,
      duration: true,
      sandbox: false,
      materialization: false,
    },
    limitations: [],
  };
  const capabilitiesPath = path.join(temporaryRoot, 'capabilities.json');
  const capabilitiesRaw = JSON.stringify(capabilities);
  await writeFile(capabilitiesPath, capabilitiesRaw, 'utf8');
  const plan = {
    schemaVersion: 2,
    planId: 'plan-1',
    target: { name: 'skill', path: './skill', digest: targetDigest },
    cases: { paths: ['./cases.json'], corpusDigest: caseCorpusDigest },
    audit: {
      path: './audit.json',
      digest: sha256(auditRaw),
      targetSkillDigest: targetDigest,
      caseCorpusDigest,
      validity: 'pass',
    },
    provider: {
      id: 'command',
      command: [process.execPath, providerPath, '{prompt}'],
      cwd: null,
      env: {},
      capabilitiesPath: './capabilities.json',
      capabilitiesDigest: sha256(capabilitiesRaw),
      inheritEnvironment: false,
    },
    configurations: [
      { id: 'with', skillMode: 'with-skill', comparisonId: 'quality', env: {} },
      { id: 'baseline', skillMode: 'without-skill', comparisonId: 'quality', env: {} },
    ],
    runsPerCase: 1,
    timeoutMs: 10000,
    outputRoot,
    capture: { outputs: true, trace: false, timing: true, usage: false },
  };
  const planPath = path.join(temporaryRoot, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan), 'utf8');
  return { temporaryRoot, skillRoot, planPath };
}

test('distributed contract assets are current', async () => {
  await execFileAsync(
    process.execPath,
    [path.join(sourceRoot, 'scripts', 'generate-contract-assets.mjs'), '--check'],
    { cwd: sourceRoot, encoding: 'utf8' },
  );
});

test('command provider emits comparative evidence and cannot mutate the source Skill', async () => {
  const fixture = await createFixture({ providerMutatesSkill: true });
  const result = JSON.parse(
    (await run('scripts/run-agent-skill-evals.mjs', [fixture.planPath, '--format', 'json'])).stdout,
  );
  await run('scripts/validate-json-contract.mjs', [
    'assets/eval-run-bundle.schema.json',
    result.bundlePath,
  ]);
  await execFileAsync(
    process.execPath,
    [
      path.resolve(
        sourceRoot,
        '..',
        'agent-skill-toolkit',
        'scripts',
        'validate-eval-run-bundle.mjs',
      ),
      result.bundlePath,
    ],
    { cwd: sourceRoot, encoding: 'utf8' },
  );
  const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));
  assert.equal(bundle.evidenceLevel, 'comparative');
  assert.equal(bundle.comparisonPlanned, true);
  assert.equal(bundle.independentContext, false);
  assert.equal(bundle.runs.length, 2);
  assert.equal(bundle.aggregate.completed, 2);
  assert.equal(bundle.aggregate.processFailed, 0);
  assert.deepEqual(bundle.aggregate.comparisons, [
    {
      comparisonId: 'quality',
      caseId: 'c1',
      runIndex: 1,
      paired: true,
      comparable: true,
    },
  ]);
  await assert.rejects(access(path.join(fixture.skillRoot, 'provider-mutation.txt')));
  const withSkill = bundle.runs.find((entry) => entry.skillMode === 'with-skill');
  const withoutSkill = bundle.runs.find((entry) => entry.skillMode === 'without-skill');
  assert.equal(withSkill.skillDigest, bundle.targetSkillDigest);
  assert.equal(withoutSkill.skillDigest, null);
  assert.equal(
    await readFile(
      path.join(
        path.dirname(result.bundlePath),
        path.dirname(withSkill.stdoutPath),
        'skill',
        'provider-mutation.txt',
      ),
      'utf8',
    ),
    'snapshot only',
  );
  await assert.rejects(
    access(
      path.join(path.dirname(result.bundlePath), path.dirname(withoutSkill.stdoutPath), 'skill'),
    ),
  );
});

test('plan validation rejects path traversal, unsafe case ids, and target/output overlap', async () => {
  const unsafeCase = await createFixture({ unsafeCaseId: true, outputRoot: '../outside' });
  await assert.rejects(
    run('scripts/validate-eval-execution-plan.mjs', [unsafeCase.planPath]),
    /Command failed/u,
  );
  const overlap = await createFixture({ outputRoot: './skill/out' });
  await assert.rejects(
    run('scripts/validate-eval-execution-plan.mjs', [overlap.planPath]),
    /Command failed/u,
  );
});

test('plan validation rejects an empty case corpus and a blocked passing audit', async () => {
  const old = await createFixture();
  const oldPlan = JSON.parse(await readFile(old.planPath, 'utf8'));
  oldPlan.schemaVersion = 1;
  await writeFile(old.planPath, JSON.stringify(oldPlan));
  await assert.rejects(
    run('scripts/validate-eval-execution-plan.mjs', [old.planPath]),
    /Command failed/u,
  );
  const empty = await createFixture({ emptyCases: true });
  await assert.rejects(
    run('scripts/validate-eval-execution-plan.mjs', [empty.planPath]),
    /Command failed/u,
  );
  const blocked = await createFixture({ blockedAudit: true });
  await assert.rejects(
    run('scripts/validate-eval-execution-plan.mjs', [blocked.planPath]),
    /Command failed/u,
  );
});

test('plan validation applies the exact EvalAuditResult item contract', async () => {
  const malformed = await createFixture({ malformedAuditCase: true });
  await assert.rejects(
    run('scripts/validate-eval-execution-plan.mjs', [malformed.planPath]),
    /Command failed/u,
  );
});

test('planned comparison stays executed when paired grading is not comparable', async () => {
  const fixture = await createFixture({ omitBaselineGrading: true });
  const result = JSON.parse(
    (await run('scripts/run-agent-skill-evals.mjs', [fixture.planPath, '--format', 'json'])).stdout,
  );
  const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));
  assert.equal(bundle.comparisonPlanned, true);
  assert.equal(bundle.evidenceLevel, 'executed');
  assert.equal(bundle.aggregate.comparisons[0].paired, true);
  assert.equal(bundle.aggregate.comparisons[0].comparable, false);
  assert.ok(bundle.limitations.some((entry) => entry.includes('quality/c1/1')));
});

test('one valid quality pair remains comparative when another run fails', async () => {
  const fixture = await createFixture({ secondCase: true, failingCaseId: 'c2' });
  const result = JSON.parse(
    (await run('scripts/run-agent-skill-evals.mjs', [fixture.planPath, '--format', 'json'])).stdout,
  );
  const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));
  assert.equal(bundle.evidenceLevel, 'comparative');
  assert.equal(bundle.aggregate.comparisons.find((entry) => entry.caseId === 'c1').comparable, true);
  assert.equal(bundle.aggregate.comparisons.find((entry) => entry.caseId === 'c2').paired, false);
  assert.ok(bundle.limitations.some((entry) => entry.includes('quality/c2/1')));
});

test('built-in Codex trigger provider has a safe help path and declared capabilities', async () => {
  const help = await run('scripts/providers/codex-trigger-provider.mjs', ['--help']);
  assert.match(help.stdout, /AW_CODEX_EVAL_DRIVER_ROOT/u);
  await run('scripts/validate-json-contract.mjs', [
    'assets/eval-runtime-capabilities.schema.json',
    'assets/codex-trigger-capabilities.json',
  ]);
  const capabilities = JSON.parse(
    await readFile(path.join(runtimeSkillRoot, 'assets/codex-trigger-capabilities.json'), 'utf8'),
  );
  assert.equal(capabilities.provider, 'codex-trigger');
  assert.equal(capabilities.capabilities.triggerDiscovery, true);
  assert.equal(capabilities.capabilities.withoutSkillBaseline, false);
});
