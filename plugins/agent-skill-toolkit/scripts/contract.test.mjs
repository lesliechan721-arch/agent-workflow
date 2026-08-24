import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = context?.sourceRoot ?? localRoot;
const bundleRoot = context?.plugin?.rootDir ?? localRoot;
const runtimeRoot = context ? path.join(bundleRoot, context.platform) : localRoot;

async function exists(root, relative) {
  return access(path.join(root, relative)).then(() => true, () => false);
}

async function runtimeExportSource(plugin, exportName) {
  const providerRoot = path.resolve(sourceRoot, '..', plugin);
  const manifest = JSON.parse(await readFile(path.join(providerRoot, '.agents-plugin/plugin.json'), 'utf8'));
  const item = manifest.buildConfig?.runtimeExports?.find((entry) => entry.name === exportName);
  assert.ok(item, `missing runtime export ${plugin}:${exportName}`);
  return path.join(providerRoot, item.source);
}

test('reviewer manifest and runtime expose only the current quality contract', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'));
  assert.deepEqual(
    manifest.buildConfig.runtimeExports.map((entry) => entry.name).sort(),
    [
      'check-agent-skill',
      'eval-audit-result-schema',
      'eval-run-bundle-schema',
      'quality-review-result-schema',
      'review-dimensions',
      'skill-design-brief-schema',
      'skill-rules',
      'validate-eval-audit-result',
      'validate-eval-run-bundle',
      'validate-json-contract',
      'validate-quality-review-result',
    ],
  );
  // Static contract exception: legacy schema and producer ownership in current plugin source would re-enter its published closure; behavior test is not suitable because ownership is the absence of these exact source files.
  for (const relative of [
    'schemas/review-input-bundle.schema.json',
    'schemas/review-result.schema.json',
    'schemas/skill-inspection-result.schema.json',
    'scripts/inspect-agent-skill.mjs',
    'scripts/validate-review-input-bundle.mjs',
    'scripts/validate-review-result.mjs',
  ]) {
    await assert.rejects(readFile(path.join(sourceRoot, relative), 'utf8'), relative);
  }
  const targets = manifest.buildConfig.skillRuntimeFiles
    .filter((entry) => entry.skill === 'review-agent-skill')
    .map((entry) => entry.target)
    .sort();
  assert.deepEqual(targets, [
    'assets/quality-review-result.schema.json',
    'assets/review-dimensions.json',
    'scripts/check-agent-skill.mjs',
    'scripts/validate-quality-review-result.mjs',
  ]);
  const reviewRoot = path.join(runtimeRoot, 'skills/review-agent-skill');
  for (const relative of [
    'assets/review-input-bundle.schema.json',
    'assets/review-result.schema.json',
    'assets/skill-inspection-result.schema.json',
    'assets/eval-execution-plan.schema.json',
    'assets/eval-run-bundle.schema.json',
    'scripts/validate-review-input-bundle.mjs',
    'scripts/validate-review-result.mjs',
    'scripts/inspect-agent-skill.mjs',
  ]) {
    await assert.rejects(readFile(path.join(reviewRoot, relative), 'utf8'), relative);
  }
});

test('projected runtime files match canonical sources', async () => {
  if (!context) return;
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'));
  for (const projection of manifest.buildConfig.skillRuntimeFiles) {
    const source = projection.source
      ? path.join(sourceRoot, projection.source)
      : await runtimeExportSource(projection.import.plugin, projection.import.export);
    const target = path.join(runtimeRoot, 'skills', projection.skill, projection.target);
    assert.deepEqual(await readFile(target), await readFile(source), `${projection.skill}/${projection.target}`);
  }
});

test('source excludes standard views rendered during staging', async () => {
  for (const relative of [
    'skills/author-agent-skill/references/author-standard.md',
    'skills/author-agent-skill/references/composition-audit.md',
    'skills/review-agent-skill/references/review-rubric.md',
    'skills/review-agent-skill/references/composition-fitness.md',
    'skills/review-agent-skill/references/evidence-and-severity.md',
    'skills/design-agent-skill-evals/references/eval-design-standard.md',
    'skills/audit-agent-skill-evals/references/eval-audit-standard.md',
  ]) {
    assert.equal(await exists(sourceRoot, relative), false, `${relative} must not exist in source`);
  }
});

test('materialized audit validator runs with its projected dependency closure', async () => {
  if (!context) return;
  const auditRoot = path.join(runtimeRoot, 'skills/audit-agent-skill-evals');
  const validator = path.join(auditRoot, 'scripts/validate-eval-audit-result.mjs');
  const templatePath = path.join(auditRoot, 'assets/eval-audit-result-template.json');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'audit-runtime-contract-'));
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      validator,
      templatePath,
      '--format',
      'json',
    ], {
      cwd: auditRoot,
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(stdout).valid, true);

    const invalid = JSON.parse(await readFile(templatePath, 'utf8'));
    invalid.runBundleDigest = 'sha256:' + '1'.repeat(64);
    const invalidPath = path.join(temporary, 'invalid-preflight.json');
    await writeFile(invalidPath, JSON.stringify(invalid));
    await assert.rejects(execFileAsync(process.execPath, [validator, invalidPath], {
      cwd: auditRoot,
      encoding: 'utf8',
    }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('audit triage rejects conclusions from an unmet bundle evidence requirement', async () => {
  const auditRoot = path.join(runtimeRoot, 'skills/audit-agent-skill-evals');
  const validator = path.join(auditRoot, 'scripts/validate-eval-audit-result.mjs');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'audit-evidence-requirement-'));
  const digest = (value) => 'sha256:' + createHash('sha256').update(value).digest('hex');
  const targetSkillDigest = 'sha256:' + '1'.repeat(64);
  const caseCorpusDigest = 'sha256:' + '2'.repeat(64);
  try {
    await writeFile(path.join(temporary, 'stdout.txt'), '');
    await writeFile(path.join(temporary, 'stderr.txt'), '');
    const bundle = {
      schemaVersion: 3,
      runner: { id: 'fixture', version: '1' },
      independentContext: true,
      provider: { id: 'fixture', version: '1' },
      planDigest: 'sha256:' + '3'.repeat(64),
      targetSkillDigest,
      caseCorpusDigest,
      comparisonPlanned: false,
      evidenceLevel: 'executed',
      evidenceRequirement: {
        minimumEvidenceLevel: 'executed',
        plannedComparisons: 0,
        comparableComparisons: 0,
        satisfied: false,
      },
      processManagement: {
        mode: 'observed',
        descendantCleanupGuaranteed: false,
        limitation: 'Provider process cleanup could not be verified.',
      },
      runs: [{
        caseId: 'case-1',
        configuration: 'current',
        comparisonId: null,
        skillMode: 'with-skill',
        skillDigest: targetSkillDigest,
        runIndex: 1,
        status: 'error',
        exitCode: 0,
        durationMs: 1,
        stdoutPath: 'stdout.txt',
        stdoutDigest: digest(''),
        stderrPath: 'stderr.txt',
        stderrDigest: digest(''),
        usage: null,
        grading: null,
        artifacts: [],
      }],
      aggregate: {
        cases: 1,
        configurations: 1,
        runs: 1,
        completed: 0,
        processFailed: 1,
        timedOut: 0,
        comparisons: [],
      },
      limitations: ['Provider process cleanup could not be verified.'],
    };
    const bundlePath = path.join(temporary, 'bundle.json');
    const bundleBytes = JSON.stringify(bundle);
    await writeFile(bundlePath, bundleBytes);
    const audit = {
      schemaVersion: 3,
      producer: 'audit-agent-skill-evals',
      independentContext: true,
      auditId: 'unmet-evidence-fixture',
      mode: 'result-triage',
      targetSkillDigest,
      caseCorpusDigest,
      runBundleDigest: digest(bundleBytes),
      validity: 'pass',
      optimizationPolicy: 'balanced',
      cases: [{
        caseId: 'case-1',
        releaseRelevant: true,
        admission: 'pass',
        oracleConfidence: 'high',
        findings: [],
      }],
      blockedCases: [],
      releaseEligible: true,
      failureTriage: [{
        caseId: 'case-1',
        attribution: 'skill-defect',
        action: 'candidate-skill-fix',
        evidence: ['fixture'],
      }],
      recommendedAction: 'candidate-skill-fix',
    };
    const auditPath = path.join(temporary, 'audit.json');
    await writeFile(auditPath, JSON.stringify(audit));

    await assert.rejects(
      execFileAsync(process.execPath, [validator, auditPath, '--run-bundle', bundlePath, '--format', 'json'], {
        cwd: auditRoot,
        encoding: 'utf8',
      }),
      (error) => {
        const errors = JSON.parse(error.stdout).errors;
        assert.ok(errors.some((entry) => entry.startsWith('releaseEligible=true')));
        assert.ok(errors.some((entry) => entry.includes('recommendedAction=collect-more-data or runtime-issue')));
        assert.ok(errors.some((entry) => entry.includes('forbids candidate-skill-fix triage actions')));
        return true;
      },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('reviewer runtime includes full dimensions without release workflow state', async () => {
  if (!context) return;
  const reviewRoot = path.join(runtimeRoot, 'skills/review-agent-skill/references');
  for (const file of ['review-rubric.md', 'composition-fitness.md', 'evidence-and-severity.md']) {
    assert.ok((await readFile(path.join(reviewRoot, file), 'utf8')).length > 100, file);
  }
  for (const file of ['review-dimensions.md', 'scoring-model.md']) {
    assert.ok((await readFile(path.join(reviewRoot, file), 'utf8')).length > 100, file);
  }
  await assert.rejects(readFile(path.join(reviewRoot, 'source-map.md'), 'utf8'));
});

test('starter author and Eval contracts remain valid', async () => {
  if (!context) return;
  const validator = path.join(runtimeRoot, 'skills/author-agent-skill/scripts/validate-json-contract.mjs');
  for (const [schema, value] of [
    [
      'skills/author-agent-skill/assets/skill-design-brief.schema.json',
      'skills/author-agent-skill/assets/skill-design-brief.template.json',
    ],
    [
      'skills/audit-agent-skill-evals/assets/eval-audit-result.schema.json',
      'skills/audit-agent-skill-evals/assets/eval-audit-result-template.json',
    ],
  ]) {
    await execFileAsync(process.execPath, [validator, path.join(runtimeRoot, schema), path.join(runtimeRoot, value)], {
      cwd: runtimeRoot,
      encoding: 'utf8',
    });
  }
});
