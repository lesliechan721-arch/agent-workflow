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
const temporaryRoots = [];
after(async () => Promise.all(temporaryRoots.map((entry) => rm(entry, { recursive: true, force: true }))));
function sha256(data) { return `sha256:${createHash('sha256').update(data).digest('hex')}`; }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function run(relative, args = []) {
  return execFileAsync(process.execPath, [path.join(root, relative), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}
async function createFixture({ unsafeCaseId = false, outputRoot = './out', providerMutatesSkill = false } = {}) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'eval-runner-'));
  temporaryRoots.push(temporaryRoot);
  const skillRoot = path.join(temporaryRoot, 'skill');
  await mkdir(skillRoot);
  const skillContent = '---\nname: skill\ndescription: fixture\n---\n';
  await writeFile(path.join(skillRoot, 'SKILL.md'), skillContent, 'utf8');
  const targetDigest = sha256(Buffer.concat([Buffer.from('SKILL.md\0'), Buffer.from(skillContent), Buffer.from('\0')]));
  const casesDocument = { cases: [{ id: unsafeCaseId ? '../escape' : 'c1', query: 'hello' }] };
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
    cases: [{ caseId: unsafeCaseId ? '../escape' : 'c1', releaseRelevant: true, admission: 'pass', oracleConfidence: 'high', findings: [] }],
    blockedCases: [],
    releaseEligible: true,
    failureTriage: [],
    recommendedAction: 'accepted-risk',
  };
  const auditPath = path.join(temporaryRoot, 'audit.json');
  const auditRaw = JSON.stringify(audit);
  await writeFile(auditPath, auditRaw, 'utf8');
  const providerPath = path.join(temporaryRoot, 'provider.mjs');
  await writeFile(providerPath, [
    "import { writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    providerMutatesSkill ? "if (process.env.AGENT_EVAL_SKILL_PATH) writeFileSync(path.join(process.env.AGENT_EVAL_SKILL_PATH, 'provider-mutation.txt'), 'snapshot only');" : '',
    "const trace = path.join(process.env.AGENT_EVAL_OUTPUT_DIR, 'trace.json');",
    "writeFileSync(trace, JSON.stringify({ ok: true }));",
    "process.stdout.write(JSON.stringify({ artifacts: [{ role: 'trace', path: trace }] }));",
  ].join('\n'), 'utf8');
  const capabilities = {
    schemaVersion: 1,
    provider: 'command',
    providerVersion: 'test',
    capabilities: { triggerDiscovery: false, skillPathExecution: true, previousVersionBaseline: true, withoutSkillBaseline: true, cleanContext: false, parallelRuns: false, toolTrace: false, tokenUsage: false, duration: true, sandbox: false, materialization: false },
    limitations: [],
  };
  const capabilitiesPath = path.join(temporaryRoot, 'capabilities.json');
  const capabilitiesRaw = JSON.stringify(capabilities);
  await writeFile(capabilitiesPath, capabilitiesRaw, 'utf8');
  const plan = {
    schemaVersion: 1,
    planId: 'plan-1',
    target: { name: 'skill', path: './skill', digest: targetDigest },
    cases: { paths: ['./cases.json'], corpusDigest: caseCorpusDigest },
    audit: { path: './audit.json', digest: sha256(auditRaw), targetSkillDigest: targetDigest, caseCorpusDigest, validity: 'pass' },
    provider: { id: 'command', command: [process.execPath, providerPath, '{prompt}'], cwd: null, env: {}, capabilitiesPath: './capabilities.json', capabilitiesDigest: sha256(capabilitiesRaw), inheritEnvironment: false },
    configurations: [{ id: 'with', skillMode: 'with-skill', env: {} }, { id: 'baseline', skillMode: 'without-skill', env: {} }],
    runsPerCase: 1,
    timeoutMs: 10000,
    outputRoot,
    capture: { outputs: true, trace: false, timing: true, usage: false },
  };
  const planPath = path.join(temporaryRoot, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan), 'utf8');
  return { temporaryRoot, skillRoot, planPath };
}

test('command provider emits comparative evidence and cannot mutate the source Skill', async () => {
  const fixture = await createFixture({ providerMutatesSkill: true });
  const result = JSON.parse((await run('scripts/run-agent-skill-evals.mjs', [fixture.planPath, '--format', 'json'])).stdout);
  await run('scripts/validate-json-contract.mjs', ['schemas/eval-run-bundle.schema.json', result.bundlePath]);
  const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));
  assert.equal(bundle.evidenceLevel, 'comparative');
  assert.equal(bundle.independentContext, false);
  assert.equal(bundle.runs.length, 2);
  assert.equal(bundle.aggregate.completed, 2);
  assert.equal(bundle.aggregate.processFailed, 0);
  await assert.rejects(access(path.join(fixture.skillRoot, 'provider-mutation.txt')));
  const withSkill = bundle.runs.find((entry) => entry.skillMode === 'with-skill');
  const withoutSkill = bundle.runs.find((entry) => entry.skillMode === 'without-skill');
  assert.equal(withSkill.skillDigest, bundle.targetSkillDigest);
  assert.equal(withoutSkill.skillDigest, null);
  assert.equal(await readFile(path.join(path.dirname(result.bundlePath), path.dirname(withSkill.stdoutPath), 'skill', 'provider-mutation.txt'), 'utf8'), 'snapshot only');
  await assert.rejects(access(path.join(path.dirname(result.bundlePath), path.dirname(withoutSkill.stdoutPath), 'skill')));
});

test('plan validation rejects path traversal, unsafe case ids, and target/output overlap', async () => {
  const unsafeCase = await createFixture({ unsafeCaseId: true, outputRoot: '../outside' });
  await assert.rejects(run('scripts/validate-eval-execution-plan.mjs', [unsafeCase.planPath]), /Command failed/u);
  const overlap = await createFixture({ outputRoot: './skill/out' });
  await assert.rejects(run('scripts/validate-eval-execution-plan.mjs', [overlap.planPath]), /Command failed/u);
});

test('built-in Codex trigger provider has a safe help path and declared capabilities', async () => {
  const help = await run('providers/codex-trigger-provider.mjs', ['--help']);
  assert.match(help.stdout, /AW_CODEX_EVAL_DRIVER_ROOT/u);
  await run('scripts/validate-json-contract.mjs', ['schemas/eval-runtime-capabilities.schema.json', 'skills/run-agent-skill-evals/assets/codex-trigger-capabilities.json']);
  const capabilities = JSON.parse(await readFile(path.join(root, 'skills/run-agent-skill-evals/assets/codex-trigger-capabilities.json'), 'utf8'));
  assert.equal(capabilities.provider, 'codex-trigger');
  assert.equal(capabilities.capabilities.triggerDiscovery, true);
  assert.equal(capabilities.capabilities.withoutSkillBaseline, false);
});
