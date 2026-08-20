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
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoots = [];
after(async () => Promise.all(temporaryRoots.map((entry) => rm(entry, { recursive: true, force: true }))));
function sha256(data) { return `sha256:${createHash('sha256').update(data).digest('hex')}`; }
function stable(value) { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`; return JSON.stringify(value); }
async function run(relative, args = []) { return execFileAsync(process.execPath, [path.join(root, relative), ...args], { cwd: root, encoding: 'utf8' }); }
function skillDigest(content) { return sha256(Buffer.concat([Buffer.from('SKILL.md\0'), Buffer.from(content), Buffer.from('\0')])); }

test('previous-version comparison binds and reports the alternate Skill digest', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'previous-version-eval-'));
  temporaryRoots.push(workspace);
  const currentRoot = path.join(workspace, 'current');
  const previousRoot = path.join(workspace, 'previous');
  await Promise.all([mkdir(currentRoot), mkdir(previousRoot)]);
  const current = '---\nname: skill\ndescription: current\n---\n';
  const previous = '---\nname: skill\ndescription: previous\n---\n';
  await Promise.all([
    writeFile(path.join(currentRoot, 'SKILL.md'), current),
    writeFile(path.join(previousRoot, 'SKILL.md'), previous),
  ]);
  const cases = { cases: [{ id: 'case-1', query: 'compare' }] };
  await writeFile(path.join(workspace, 'cases.json'), JSON.stringify(cases));
  const corpusDigest = sha256(stable(cases));
  const audit = {
    schemaVersion: 2, producer: 'audit-agent-skill-evals', independentContext: true,
    auditId: 'audit-1', mode: 'preflight', targetSkillDigest: skillDigest(current),
    caseCorpusDigest: corpusDigest, validity: 'pass', optimizationPolicy: 'balanced',
    cases: [{ caseId: 'case-1', releaseRelevant: true, admission: 'pass', oracleConfidence: 'high', findings: [] }],
    blockedCases: [], releaseEligible: true, failureTriage: [], recommendedAction: 'accepted-risk',
  };
  const auditRaw = JSON.stringify(audit);
  await writeFile(path.join(workspace, 'audit.json'), auditRaw);
  const provider = path.join(workspace, 'provider.mjs');
  await writeFile(provider, "process.stdout.write('{}');\n");
  const capabilities = {
    schemaVersion: 1, provider: 'command', providerVersion: 'test',
    capabilities: { triggerDiscovery: false, skillPathExecution: true, previousVersionBaseline: true, withoutSkillBaseline: false, cleanContext: false, parallelRuns: false, toolTrace: false, tokenUsage: false, duration: true, sandbox: false, materialization: false },
    limitations: [],
  };
  const capabilitiesRaw = JSON.stringify(capabilities);
  await writeFile(path.join(workspace, 'capabilities.json'), capabilitiesRaw);
  const plan = {
    schemaVersion: 1, planId: 'plan', target: { name: 'skill', path: './current', digest: skillDigest(current) },
    cases: { paths: ['./cases.json'], corpusDigest },
    audit: { path: './audit.json', digest: sha256(auditRaw), targetSkillDigest: skillDigest(current), caseCorpusDigest: corpusDigest, validity: 'pass' },
    provider: { id: 'command', command: [process.execPath, provider], cwd: null, env: {}, capabilitiesPath: './capabilities.json', capabilitiesDigest: sha256(capabilitiesRaw), inheritEnvironment: false },
    configurations: [
      { id: 'with', skillMode: 'with-skill', env: {} },
      { id: 'previous', skillMode: 'previous-version', skillPath: './previous', skillDigest: skillDigest(previous), env: {} },
    ],
    runsPerCase: 1, timeoutMs: 10000, outputRoot: './out', capture: { outputs: true, trace: false, timing: true, usage: false },
  };
  const planPath = path.join(workspace, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  const result = JSON.parse((await run('scripts/run-agent-skill-evals.mjs', [planPath, '--format', 'json'])).stdout);
  const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));
  assert.equal(bundle.evidenceLevel, 'comparative');
  assert.equal(bundle.runs.find((entry) => entry.skillMode === 'previous-version').skillDigest, skillDigest(previous));
});
