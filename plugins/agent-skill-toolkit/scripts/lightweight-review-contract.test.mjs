#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
const root = context
  ? path.join(context.plugin.rootDir, context.platform, 'skills/review-agent-skill/scripts')
  : localRoot;
const checker = path.join(root, 'check-agent-skill.mjs');
const validator = path.join(root, 'validate-quality-review-result.mjs');
const temp = await mkdtemp(path.join(os.tmpdir(), 'lightweight-review-'));
const dimensionIds = [
  'specification',
  'problem_value',
  'triggering',
  'scope_composition',
  'instruction_design',
  'minimum_control',
  'context_disclosure',
  'architecture',
  'scripts',
  'evals',
  'reliability',
  'maintainability',
];

function fullDimensions(score = 4, confidence = 'medium') {
  return dimensionIds.map((id) => ({ id, score, confidence, basis: `${id} is supported by the supplied package.` }));
}

async function run(file, args, expectFailure = false) {
  try {
    return await execFileAsync(process.execPath, [file, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AW_SKILL_VALIDATOR_BIN: path.resolve(sourceRoot, '..', '..', 'packages', 'cli', 'dist', 'index.js'),
      },
    });
  } catch (error) {
    if (!expectFailure) throw error;
    return { stdout: error.stdout, stderr: error.stderr };
  }
}

try {
  const good = path.join(temp, 'good-skill');
  await mkdir(path.join(good, 'references'), { recursive: true });
  await writeFile(path.join(good, 'SKILL.md'), '---\nname: good-skill\ndescription: Review supplied facts.\n---\n\nRead [the guide](references/guide.md).\n');
  await writeFile(path.join(good, 'references', 'guide.md'), '# Guide\n\nReturn the key facts.\n');
  const goodCheckPath = path.join(temp, 'good-check.json');
  const goodRun = await run(checker, [good, '--output', goodCheckPath]);
  const goodCheck = JSON.parse(goodRun.stdout);
  assert.equal(goodCheck.ok, true);

  const projectedPlugin = path.join(temp, 'projected-plugin');
  const projected = path.join(projectedPlugin, 'skills', 'projected-skill');
  await mkdir(path.join(projectedPlugin, '.agents-plugin'), { recursive: true });
  await mkdir(projected, { recursive: true });
  await writeFile(path.join(projectedPlugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'projected-plugin',
    skills: './skills',
    buildConfig: {
      skillRuntimeFiles: [
        { skill: 'projected-skill', source: './scripts/tool.mjs', target: 'scripts/tool.mjs' }
      ]
    }
  }));
  await writeFile(path.join(projected, 'SKILL.md'), '---\nname: projected-skill\ndescription: Run the projected tool.\n---\n\nRun `node scripts/tool.mjs`.\n');
  const projectedRun = await run(checker, [projected, '--root-kind', 'source']);
  const projectedCheck = JSON.parse(projectedRun.stdout);
  assert.equal(projectedCheck.ok, true);
  assert.ok(projectedCheck.warnings.some((entry) => entry.code === 'declared-runtime-projection'));

  const bad = path.join(temp, 'bad-skill');
  await mkdir(path.join(bad, 'references'), { recursive: true });
  await writeFile(path.join(bad, 'SKILL.md'), '---\nname: bad-skill\ndescription: Run the supplied workflow.\n---\n\nRead [the guide](references/guide.md).\n');
  await writeFile(path.join(bad, 'references', 'guide.md'), '# Guide\n\nRun `node scripts/missing.mjs`.\n');
  const badCheckPath = path.join(temp, 'bad-check.json');
  const badRun = await run(checker, [bad, '--output', badCheckPath], true);
  const badCheck = JSON.parse(badRun.stdout);
  assert.equal(badCheck.ok, false);
  assert.ok(badCheck.errors.some((entry) => entry.code === 'missing-runtime-resource' && entry.origin === 'references/guide.md'));

  const indentedCommand = path.join(temp, 'indented-command-skill');
  await mkdir(indentedCommand, { recursive: true });
  await writeFile(
    path.join(indentedCommand, 'SKILL.md'),
    '---\nname: indented-command-skill\ndescription: Run the required validation command.\n---\n\n```bash\n   $ node scripts/missing.mjs --format json\n```\n',
  );
  const indentedCommandRun = await run(checker, [indentedCommand], true);
  const indentedCommandCheck = JSON.parse(indentedCommandRun.stdout);
  assert.equal(indentedCommandCheck.ok, false);
  assert.ok(indentedCommandCheck.errors.some((entry) =>
    entry.code === 'missing-runtime-resource' && entry.path === 'scripts/missing.mjs'));

  const example = path.join(temp, 'example-skill');
  await mkdir(example, { recursive: true });
  await writeFile(path.join(example, 'SKILL.md'), '---\nname: example-skill\ndescription: Explain one resource example.\n---\n\n```text\nreferences/example-only.md\n```\n');
  const exampleRun = await run(checker, [example]);
  const exampleCheck = JSON.parse(exampleRun.stdout);
  assert.equal(exampleCheck.ok, true);
  assert.ok(exampleCheck.warnings.some((entry) => entry.code === 'example-resource-reference'));

  const reviewPath = path.join(temp, 'review.json');
  await writeFile(reviewPath, JSON.stringify({
    schemaVersion: 1,
    target: { name: goodCheck.target.name, digest: goodCheck.target.digest },
    mode: 'quick',
    design: 'pass',
    complexity: 'proportionate',
    findings: [],
    unknowns: [],
    dimensions: []
  }, null, 2));
  const valid = JSON.parse((await run(validator, [reviewPath, '--check', goodCheckPath])).stdout);
  assert.equal(valid.valid, true);
  assert.equal(valid.effectiveDecision, 'pass');
  assert.equal(valid.complexity, 'proportionate');

  const invalidVersion = JSON.parse(await readFile(reviewPath, 'utf8'));
  invalidVersion.schemaVersion = 2;
  const invalidVersionPath = path.join(temp, 'invalid-version-review.json');
  await writeFile(invalidVersionPath, JSON.stringify(invalidVersion));
  const invalidVersionRun = await run(validator, [invalidVersionPath, '--check', goodCheckPath], true);
  assert.equal(JSON.parse(invalidVersionRun.stdout).valid, false);

  const declaredEvalEvidence = JSON.parse(await readFile(reviewPath, 'utf8'));
  declaredEvalEvidence.evalEvidence = 'comparative';
  const declaredEvalEvidencePath = path.join(temp, 'declared-eval-evidence.json');
  await writeFile(declaredEvalEvidencePath, JSON.stringify(declaredEvalEvidence));
  const declaredEvalEvidenceRun = await run(
    validator,
    [declaredEvalEvidencePath, '--check', goodCheckPath],
    true,
  );
  assert.ok(JSON.parse(declaredEvalEvidenceRun.stdout).errors.includes('review.evalEvidence is not allowed'));

  const declaredMachineTruth = JSON.parse(await readFile(reviewPath, 'utf8'));
  Object.assign(declaredMachineTruth, {
    weightedScore: 100,
    coverage: 100,
    confidence: 'high',
    effectiveDecision: 'pass',
  });
  const declaredMachineTruthPath = path.join(temp, 'declared-machine-truth.json');
  await writeFile(declaredMachineTruthPath, JSON.stringify(declaredMachineTruth));
  const declaredMachineTruthRun = await run(
    validator,
    [declaredMachineTruthPath, '--check', goodCheckPath],
    true,
  );
  const declaredMachineTruthErrors = JSON.parse(declaredMachineTruthRun.stdout).errors;
  for (const field of ['weightedScore', 'coverage', 'confidence', 'effectiveDecision']) {
    assert.ok(declaredMachineTruthErrors.includes(`review.${field} is not allowed`));
  }

  const emptyOptionalFindingFields = JSON.parse(await readFile(reviewPath, 'utf8'));
  emptyOptionalFindingFields.design = 'needs-fixes';
  emptyOptionalFindingFields.findings = [{
    severity: 'minor',
    area: 'maintainability',
    evidenceType: 'structural',
    evidence: ['SKILL.md:1'],
    issue: 'The maintenance boundary is unclear.',
    affectedScenario: '',
    owner: 'skill',
    action: 'Clarify the maintenance boundary.',
    validation: '',
  }];
  const emptyOptionalFindingFieldsPath = path.join(temp, 'empty-optional-finding-fields.json');
  await writeFile(emptyOptionalFindingFieldsPath, JSON.stringify(emptyOptionalFindingFields));
  const emptyOptionalFindingFieldsRun = await run(
    validator,
    [emptyOptionalFindingFieldsPath, '--check', goodCheckPath],
    true,
  );
  const emptyOptionalFindingFieldErrors = JSON.parse(emptyOptionalFindingFieldsRun.stdout).errors;
  assert.ok(emptyOptionalFindingFieldErrors.includes(
    'findings[0].affectedScenario must be a non-empty string',
  ));
  assert.ok(emptyOptionalFindingFieldErrors.includes(
    'findings[0].validation must be a non-empty string',
  ));

  const badReviewPath = path.join(temp, 'bad-review.json');
  await writeFile(badReviewPath, JSON.stringify({
    schemaVersion: 1,
    target: { name: badCheck.target.name, digest: badCheck.target.digest },
    mode: 'full',
    design: 'pass',
    complexity: 'proportionate',
    findings: [],
    unknowns: [],
    dimensions: fullDimensions()
  }, null, 2));
  const combined = JSON.parse((await run(validator, [badReviewPath, '--check', badCheckPath])).stdout);
  assert.equal(combined.valid, true);
  assert.equal(combined.machineCheck, 'fail');
  assert.equal(combined.effectiveDecision, 'fail');
  assert.deepEqual(combined.scoring, {
    weightedScore: 80,
    coveragePercent: 100,
    confidenceIndex: 0.7,
    confidence: 'medium',
  });

  const mismatch = JSON.parse(await readFile(reviewPath, 'utf8'));
  mismatch.target.digest = badCheck.target.digest;
  const mismatchPath = path.join(temp, 'mismatch.json');
  await writeFile(mismatchPath, JSON.stringify(mismatch));
  const mismatchRun = await run(validator, [mismatchPath, '--check', goodCheckPath], true);
  assert.equal(JSON.parse(mismatchRun.stdout).valid, false);

  const overSpecified = JSON.parse(await readFile(reviewPath, 'utf8'));
  overSpecified.complexity = 'over-specified';
  const overSpecifiedPath = path.join(temp, 'over-specified.json');
  await writeFile(overSpecifiedPath, JSON.stringify(overSpecified));
  const overSpecifiedRun = await run(validator, [overSpecifiedPath, '--check', goodCheckPath], true);
  assert.equal(JSON.parse(overSpecifiedRun.stdout).valid, false);

  const incomplete = JSON.parse(await readFile(badReviewPath, 'utf8'));
  incomplete.design = 'not-assessed';
  incomplete.dimensions[0] = {
    id: 'specification',
    score: null,
    confidence: 'unknown',
    basis: 'The target client contract is unavailable.',
  };
  const incompletePath = path.join(temp, 'incomplete.json');
  await writeFile(incompletePath, JSON.stringify(incomplete));
  const incompleteResult = JSON.parse((await run(validator, [incompletePath, '--check', badCheckPath])).stdout);
  assert.equal(incompleteResult.valid, true);
  assert.equal(incompleteResult.scoring.weightedScore, null);
  assert.equal(incompleteResult.scoring.coveragePercent, 94);
  assert.equal(incompleteResult.scoring.confidence, 'medium');

  const incompleteCritical = JSON.parse(await readFile(incompletePath, 'utf8'));
  incompleteCritical.design = 'fail';
  incompleteCritical.findings = [{
    severity: 'critical',
    area: 'reliability',
    evidenceType: 'observed',
    evidence: ['trace.json:1'],
    issue: 'The core workflow corrupts the target artifact.',
    affectedScenario: 'Every normal execution overwrites the target with invalid bytes.',
    owner: 'script',
    action: 'Stop the invalid write before release.',
    validation: 'Run the observed reproduction and confirm the target remains valid.',
  }];
  const incompleteCriticalPath = path.join(temp, 'incomplete-critical.json');
  await writeFile(incompleteCriticalPath, JSON.stringify(incompleteCritical));
  const incompleteCriticalResult = JSON.parse((await run(
    validator,
    [incompleteCriticalPath, '--check', badCheckPath],
  )).stdout);
  assert.equal(incompleteCriticalResult.valid, true);
  assert.equal(incompleteCriticalResult.design, 'fail');

  const major = JSON.parse(await readFile(reviewPath, 'utf8'));
  major.design = 'needs-fixes';
  major.findings = [{
    severity: 'major',
    area: 'triggering',
    evidenceType: 'heuristic',
    evidence: ['SKILL.md:1'],
    issue: 'The trigger is too broad.',
    affectedScenario: 'A near-miss request loads the Skill.',
    owner: 'skill',
    action: 'Narrow the description.',
    validation: 'Run the trigger near-miss case.',
  }];
  const majorPath = path.join(temp, 'major.json');
  await writeFile(majorPath, JSON.stringify(major));
  const majorResult = await run(validator, [majorPath, '--check', goodCheckPath], true);
  assert.ok(JSON.parse(majorResult.stdout).errors.some((entry) => entry.includes('high severity requires')));

  process.stdout.write('lightweight review contracts passed\n');
} finally {
  await rm(temp, { recursive: true, force: true });
}
