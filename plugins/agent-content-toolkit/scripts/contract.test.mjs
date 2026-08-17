import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const execFileAsync = promisify(execFile);
const localPluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8')).sourceRoot
  : localPluginRoot;
const validator = path.join(pluginRoot, 'scripts', 'validate-json-contract.mjs');
const reviewValidator = path.join(pluginRoot, 'scripts', 'validate-review-result.mjs');
const evalAuditValidator = path.join(pluginRoot, 'scripts', 'validate-eval-audit-result.mjs');
const temporaryRoots = [];

async function run(script, args = []) {
  return execFileAsync(process.execPath, [script, ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test('generated standards and contract assets are current', async () => {
  await run(path.join(pluginRoot, 'scripts', 'validate-standard-views.mjs'));
  await run(path.join(pluginRoot, 'scripts', 'validate-contract-assets.mjs'));
});

test('starter handoff documents satisfy their canonical schemas', async () => {
  const pairs = [
    [
      'schemas/skill-design-brief.schema.json',
      'skills/author-agent-skill/assets/skill-design-brief.template.json',
    ],
    [
      'schemas/eval-audit-result.schema.json',
      'skills/audit-agent-skill-evals/assets/eval-audit-result-template.json',
    ],
    [
      'schemas/reference-audit-result.schema.json',
      'skills/review-agent-content/assets/reference-audit-result.template.json',
    ],
  ];
  for (const [schema, value] of pairs) {
    await run(validator, [path.join(pluginRoot, schema), path.join(pluginRoot, value)]);
  }
  await run(reviewValidator, [
    path.join(pluginRoot, 'skills/review-agent-skill/assets/review-result-template.json'),
  ]);
  await run(evalAuditValidator, [
    path.join(pluginRoot, 'skills/audit-agent-skill-evals/assets/eval-audit-result-template.json'),
  ]);
});

test('ReviewResult rejects missing gates and a score for partial coverage', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'agent-content-toolkit-gates-'));
  temporaryRoots.push(temporaryRoot);
  const template = JSON.parse(await readFile(
    path.join(pluginRoot, 'skills/review-agent-skill/assets/review-result-template.json'),
    'utf8',
  ));
  const missingGatesPath = path.join(temporaryRoot, 'missing-gates.json');
  await writeFile(missingGatesPath, JSON.stringify({ ...template, gates: {} }), 'utf8');
  await assert.rejects(run(reviewValidator, [missingGatesPath]), /Command failed/u);

  const rules = JSON.parse(await readFile(path.join(pluginRoot, 'standards', 'rules.json'), 'utf8'));
  template.mode = 'full';
  template.dimensions = rules.dimensions.map((dimension, index) => ({
    id: dimension.id,
    weight: dimension.weight,
    score: index === 0 ? 5 : null,
    confidence: index === 0 ? 'high' : 'unknown',
    findingIds: [],
    unknownIds: [],
  }));
  template.coverage = 6;
  template.confidence = 'low';
  template.releaseReadiness = 'provisional';
  template.weightedScore = 100;
  const partialPath = path.join(temporaryRoot, 'partial.json');
  await writeFile(partialPath, JSON.stringify(template), 'utf8');
  await assert.rejects(run(reviewValidator, [partialPath]), /Command failed/u);
  template.weightedScore = null;
  await writeFile(partialPath, JSON.stringify(template), 'utf8');
  await run(reviewValidator, [partialPath]);
});

test('EvalAuditResult requires independent passing evidence and corpus binding', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'agent-content-toolkit-audit-'));
  temporaryRoots.push(temporaryRoot);
  const casePath = path.join(temporaryRoot, 'case.json');
  await writeFile(casePath, JSON.stringify({ id: 'case-1', prompt: 'example' }), 'utf8');
  const digest = (await run(evalAuditValidator, ['--digest-only', '--case', casePath])).stdout.trim();
  const audit = {
    schemaVersion: 1,
    producer: 'audit-agent-skill-evals',
    independentContext: true,
    auditId: 'audit-1',
    mode: 'preflight',
    corpusDigest: digest,
    validity: 'pass',
    optimizationPolicy: 'balanced',
    cases: [{ caseId: 'case-1', releaseRelevant: true, admission: 'pass', oracleConfidence: 'high', findings: [] }],
    blockedCases: [],
    releaseEligible: true,
    failureTriage: [],
    recommendedAction: 'accepted-risk',
  };
  const auditPath = path.join(temporaryRoot, 'audit.json');
  await writeFile(auditPath, JSON.stringify(audit), 'utf8');
  await run(evalAuditValidator, [auditPath, '--case', casePath]);
  audit.independentContext = false;
  await writeFile(auditPath, JSON.stringify(audit), 'utf8');
  await assert.rejects(run(evalAuditValidator, [auditPath, '--case', casePath]), /Command failed/u);
});

test('ReviewResult semantic gates reject an overloaded passing design', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'agent-content-toolkit-'));
  temporaryRoots.push(temporaryRoot);
  const value = JSON.parse(await readFile(
    path.join(pluginRoot, 'skills/review-agent-skill/assets/review-result-template.json'),
    'utf8',
  ));
  value.composition = 'overloaded';
  value.design = 'pass';
  const valuePath = path.join(temporaryRoot, 'review-result.json');
  await writeFile(valuePath, JSON.stringify(value), 'utf8');
  await assert.rejects(run(reviewValidator, [valuePath]), /Command failed/u);
});

test('full ReviewResult uses all 12 canonical dimensions and weights', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'agent-content-toolkit-full-'));
  temporaryRoots.push(temporaryRoot);
  const [value, rules] = await Promise.all([
    readFile(
      path.join(pluginRoot, 'skills/review-agent-skill/assets/review-result-template.json'),
      'utf8',
    ).then(JSON.parse),
    readFile(path.join(pluginRoot, 'standards', 'rules.json'), 'utf8').then(JSON.parse),
  ]);
  value.mode = 'full';
  value.design = 'pass';
  value.releaseReadiness = 'provisional';
  value.complexity = 'proportionate';
  value.composition = 'coherent';
  value.reducibility = 'minor';
  value.dimensions = rules.dimensions.map((dimension) => ({
    id: dimension.id,
    weight: dimension.weight,
    score: 5,
    confidence: 'high',
    findingIds: [],
    unknownIds: [],
  }));
  value.weightedScore = 100;
  value.coverage = 100;
  value.confidence = 'high';
  const valuePath = path.join(temporaryRoot, 'review-result.json');
  await writeFile(valuePath, JSON.stringify(value), 'utf8');
  const result = await run(reviewValidator, [valuePath, '--format', 'json']);
  assert.deepEqual(JSON.parse(result.stdout), {
    valid: true,
    errors: [],
    calculated: { weightedScore: 100, coverage: 100 },
  });
});
