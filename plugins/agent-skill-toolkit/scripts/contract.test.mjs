import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  if (plugin === '@aw/agent-skill-eval') {
    const sources = {
      'case-corpus-digest': 'dist/corpus-digest.js',
      'eval-audit-result-schema': 'dist/schemas/eval-audit-result.schema.json',
      'eval-run-bundle-schema': 'dist/schemas/eval-run-bundle.schema.json',
      'eval-run-bundle-validator': 'dist/bundle-validation-runtime.js',
    };
    assert.ok(sources[exportName], `missing virtual runtime export ${plugin}:${exportName}`);
    return path.resolve(sourceRoot, '../../packages/agent-skill-eval', sources[exportName]);
  }
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
      'quality-review-result-schema',
      'review-dimensions',
      'review-publication-reference',
      'skill-design-brief-schema',
      'skill-rules',
      'validate-eval-audit-result',
      'validate-eval-run-bundle',
      'validate-json-contract',
      'validate-quality-review-result',
    ],
  );
  assert.deepEqual(
    manifest.buildConfig.runtimeExports.map((entry) => `${entry.name}:${entry.source}`).sort(),
    [
      'check-agent-skill:./scripts/check-agent-skill.mjs',
      'quality-review-result-schema:./schemas/quality-review-result.schema.json',
      'review-dimensions:./standards/review-dimensions.json',
      'review-publication-reference:./references/review-publication.md',
      'skill-design-brief-schema:./schemas/skill-design-brief.schema.json',
      'skill-rules:./standards/skill-rules.json',
      'validate-eval-audit-result:./scripts/validate-eval-audit-result.mjs',
      'validate-eval-run-bundle:./scripts/validate-eval-run-bundle.mjs',
      'validate-json-contract:./scripts/validate-json-contract.mjs',
      'validate-quality-review-result:./scripts/validate-quality-review-result.mjs',
    ],
  );
  for (const runtimeExport of manifest.buildConfig.runtimeExports) {
    assert.deepEqual(
      runtimeExport.requires.aw.capabilities,
      runtimeExport.name === 'review-publication-reference'
        ? ['aw.review-publication.v1']
        : [],
    );
  }
  assert.deepEqual(manifest.requires.aw.capabilities, [
    'aw.review-publication.v1',
    'aw.skill-validation.v1',
  ]);
  const targets = manifest.buildConfig.skillRuntimeFiles
    .filter((entry) => entry.skill === 'review-agent-skill')
    .map((entry) => entry.target)
    .sort();
  assert.deepEqual(targets, [
    'assets/quality-review-result.schema.json',
    'assets/review-dimensions.json',
    'references/review-publication.md',
    'scripts/check-agent-skill.mjs',
    'scripts/validate-quality-review-result.mjs',
  ]);
});

test('reviewer production and materialized closures use registered current dependencies', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'));
  assert.deepEqual(
    manifest.buildConfig.buildImports.map((entry) => `${entry.plugin}:${entry.export}`).sort(),
    [
      '@aw/agent-skill-eval:case-corpus-digest',
      '@aw/agent-skill-eval:eval-run-bundle-validator',
      'agent-content-toolkit:content-rules',
    ],
  );
  assert.deepEqual(
    manifest.buildConfig.skillRuntimeFiles
      .flatMap((entry) => entry.import ? [`${entry.import.plugin}:${entry.import.export}`] : [])
      .sort(),
    [
      '@aw/agent-skill-eval:eval-audit-result-schema',
      '@aw/agent-skill-eval:eval-run-bundle-schema',
    ],
  );
  if (!context) return;
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
  const checker = await readFile(path.join(reviewRoot, 'scripts/check-agent-skill.mjs'), 'utf8');
  assert.doesNotMatch(checker, /AW_SKILL_VALIDATOR_BIN|packages\/cli\/dist/u);
  assert.match(checker, /execFileAsync\('aw'/u);
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
    const { stdout } = await execFileAsync(process.execPath, [validator, '--help'], {
      cwd: auditRoot,
      encoding: 'utf8',
    });
    assert.match(stdout, /--plan <plan\.json>/u);

    const sourceOnly = await execFileAsync(process.execPath, [
      validator, templatePath, '--format', 'json',
    ], {
      cwd: auditRoot,
      encoding: 'utf8',
    });
    assert.equal(JSON.parse(sourceOnly.stdout).valid, true);

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

test('Eval case validator admits exact trigger routes only at the trigger layer', async () => {
  const validator = path.join(
    runtimeRoot,
    'skills/audit-agent-skill-evals/scripts/validate-eval-cases.mjs',
  );
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'eval-case-route-contract-'));
  const routeCase = {
    id: 'catalog_review_route',
    split: 'validation',
    eval_type: 'trigger',
    test_layer: 'trigger',
    case_role: 'regression',
    provenance: 'derived',
    scenario_family: 'catalog-routing',
    unit_under_test: 'Catalog trigger description',
    preconditions: { target_available: true },
    expected_loaded_skills: ['review-aw-catalog'],
    oracle: {
      rationale: 'A Catalog composition review has one exact owner.',
      rule_refs: ['SKILL.md description'],
      confidence: 'high',
      allowed_variance: 'The route may explain the boundary but must load only the owner.',
      minimal_counterexample: 'A Catalog write request routes to the Catalog Author.',
    },
  };
  const document = {
    policy: {
      optimization: 'precision-first',
      false_negative_cost: 'high',
      false_positive_cost: 'critical',
      rationale: 'Sibling co-load crosses a critical ownership boundary.',
    },
    cases: [routeCase],
  };
  try {
    const triggerPath = path.join(temporary, 'trigger.json');
    await writeFile(triggerPath, JSON.stringify(document));
    const { stdout } = await execFileAsync(process.execPath, [
      validator, triggerPath, '--strict', '--format', 'json',
    ], { encoding: 'utf8' });
    const triggerResult = JSON.parse(stdout);
    assert.equal(triggerResult.valid, true);
    assert.equal(triggerResult.summary.errors, 0);
    assert.equal(triggerResult.summary.warnings, 0);

    const behaviorPath = path.join(temporary, 'behavior.json');
    await writeFile(behaviorPath, JSON.stringify({
      ...document,
      cases: [{ ...routeCase, eval_type: 'behavior', test_layer: 'conversation' }],
    }));
    await assert.rejects(
      execFileAsync(process.execPath, [
        validator, behaviorPath, '--strict', '--format', 'json',
      ], { encoding: 'utf8' }),
      (error) => {
        const result = JSON.parse(error.stdout);
        return result.diagnostics.some((entry) =>
          entry.code === 'case.route-expectation-type' && entry.level === 'error');
      },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('materialized audit validator uses the canonical corpus digest runtime', async () => {
  if (!context) return;
  const auditRoot = path.join(runtimeRoot, 'skills/audit-agent-skill-evals');
  const runtimeDigest = path.join(auditRoot, 'scripts/corpus-digest.mjs');
  const packageDigest = path.resolve(sourceRoot, '../../packages/agent-skill-eval/dist/corpus-digest.js');
  assert.deepEqual(await readFile(runtimeDigest), await readFile(packageDigest));
});

test('materialized Bundle validator matches the canonical package validator', async () => {
  if (!context) return;
  const auditRoot = path.join(runtimeRoot, 'skills/audit-agent-skill-evals');
  const validator = path.join(auditRoot, 'scripts/validate-eval-run-bundle.mjs');
  const packageValidator = path.resolve(sourceRoot, '../../packages/agent-skill-eval/dist/bin.js');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'bundle-validator-differential-'));
  const digest = (value) => 'sha256:' + createHash('sha256').update(value).digest('hex');
  const targetSkillDigest = 'sha256:' + '1'.repeat(64);
  const evidenceRoot = path.join(temporary, 'evidence');
  const runRoot = path.join(evidenceRoot, 'case-1', 'current', '1');
  const baselineRoot = path.join(evidenceRoot, 'case-1', 'baseline', '1');
  const grading = {
    grader: { id: 'fixture-grader', version: '1' },
    result: { score: 1 },
  };
  const providerOutput = {
    schemaVersion: 1,
    provider: { id: 'fixture-provider', version: '1' },
    usage: { tokens: 2 },
    grading,
    artifacts: [{ path: 'provider.txt', role: 'output' }],
  };
  async function pluginValidation(bundlePath) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [validator, bundlePath, '--format', 'json'], {
        cwd: auditRoot,
        encoding: 'utf8',
      });
      return JSON.parse(stdout);
    } catch (error) {
      return JSON.parse(error.stdout);
    }
  }
  async function packageValidation(bundlePath) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        packageValidator,
        'bundle',
        'validate',
        bundlePath,
      ], { encoding: 'utf8' });
      return JSON.parse(stdout);
    } catch (error) {
      return JSON.parse(error.stdout);
    }
  }
  try {
    await Promise.all([
      mkdir(runRoot, { recursive: true }),
      mkdir(baselineRoot, { recursive: true }),
    ]);
    const stdout = JSON.stringify(providerOutput);
    const gradingRaw = JSON.stringify(grading);
    await writeFile(path.join(runRoot, 'stdout.txt'), stdout);
    await writeFile(path.join(runRoot, 'stderr.txt'), '');
    await writeFile(path.join(runRoot, 'provider.txt'), 'provider\n');
    await writeFile(path.join(runRoot, 'grading.json'), gradingRaw);
    await writeFile(path.join(baselineRoot, 'stdout.txt'), stdout);
    await writeFile(path.join(baselineRoot, 'stderr.txt'), '');
    await writeFile(path.join(baselineRoot, 'provider.txt'), 'provider\n');
    await writeFile(path.join(baselineRoot, 'grading.json'), gradingRaw);
    const bundle = {
      schemaVersion: 4,
      runner: { id: 'fixture-runner', version: '1' },
      independentContext: true,
      provider: { id: 'fixture-provider', version: '1' },
      providerCapabilitiesDigest: 'sha256:' + '2'.repeat(64),
      planDigest: 'sha256:' + '3'.repeat(64),
      targetSkillDigest,
      caseCorpusDigest: 'sha256:' + '4'.repeat(64),
      runtimeInputs: [{ id: 'workspace', digest: 'sha256:' + '5'.repeat(64) }],
      comparisonPlanned: false,
      evidenceLevel: 'executed',
      processManagement: { mode: 'managed', descendantCleanupGuaranteed: true },
      runs: [{
        caseId: 'case-1',
        configuration: 'current',
        comparisonId: null,
        skillMode: 'with-skill',
        skillDigest: targetSkillDigest,
        runIndex: 1,
        status: 'completed',
        exitCode: 0,
        durationMs: 1,
        stdoutPath: 'case-1/current/1/stdout.txt',
        stdoutDigest: digest(stdout),
        stderrPath: 'case-1/current/1/stderr.txt',
        stderrDigest: digest(''),
        usage: providerOutput.usage,
        grading,
        artifacts: [
          { role: 'output', path: 'case-1/current/1/provider.txt', digest: digest('provider\n') },
          { role: 'grading', path: 'case-1/current/1/grading.json', digest: digest(gradingRaw) },
        ],
      }],
      aggregate: {
        cases: 1,
        configurations: 1,
        runs: 1,
        completed: 1,
        processFailed: 0,
        timedOut: 0,
        comparisons: [],
      },
      limitations: [],
    };
    for (const [name, mutate] of [
      ['valid', () => undefined],
      ['usage', (value) => { value.runs[0].usage.tokens = 9; }],
      ['grading', (value) => { value.runs[0].grading.result.score = 0; }],
      ['runtime-input-id', (value) => { value.runtimeInputs.push({ ...value.runtimeInputs[0] }); }],
      ['comparison', (value) => {
        value.runs[0].comparisonId = 'pair-1';
        const baseline = structuredClone(value.runs[0]);
        baseline.configuration = 'baseline';
        baseline.skillMode = 'without-skill';
        baseline.skillDigest = null;
        baseline.stdoutPath = baseline.stdoutPath.replace('/current/', '/baseline/');
        baseline.stderrPath = baseline.stderrPath.replace('/current/', '/baseline/');
        baseline.artifacts = baseline.artifacts.map((artifact) => ({
          ...artifact,
          path: artifact.path.replace('/current/', '/baseline/'),
        }));
        value.runs.push(baseline);
        value.comparisonPlanned = true;
        value.evidenceLevel = 'comparative';
        value.aggregate.configurations = 2;
        value.aggregate.runs = 2;
        value.aggregate.completed = 2;
        value.aggregate.comparisons = [{
          comparisonId: 'pair-1',
          caseId: 'case-1',
          runIndex: 1,
          paired: true,
          comparable: true,
        }];
      }],
    ]) {
      const value = structuredClone(bundle);
      mutate(value);
      const bundlePath = path.join(evidenceRoot, `${name}.json`);
      await writeFile(bundlePath, JSON.stringify(value));
      const canonical = await packageValidation(bundlePath);
      const projected = await pluginValidation(bundlePath);
      assert.equal(projected.valid, canonical.valid, name);
      assert.deepEqual(projected.errors, canonical.errors, name);
      assert.deepEqual(projected.calculated, canonical.calculated, name);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('audit triage rejects conclusions from an unmet bundle evidence requirement', async () => {
  if (!context) return;
  const auditRoot = path.join(runtimeRoot, 'skills/audit-agent-skill-evals');
  const validator = path.join(auditRoot, 'scripts/validate-eval-audit-result.mjs');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'audit-evidence-requirement-'));
  const digest = (value) => 'sha256:' + createHash('sha256').update(value).digest('hex');
  const targetSkillDigest = 'sha256:' + '1'.repeat(64);
  const caseCorpusDigest = 'sha256:' + '2'.repeat(64);
  try {
    const stdout = JSON.stringify({
      schemaVersion: 1,
      provider: { id: 'fixture', version: '1' },
      usage: null,
      grading: null,
      artifacts: [],
    });
    await writeFile(path.join(temporary, 'stdout.txt'), stdout);
    await writeFile(path.join(temporary, 'stderr.txt'), '');
    const bundle = {
      schemaVersion: 4,
      runner: { id: 'fixture', version: '1' },
      independentContext: true,
      provider: { id: 'fixture', version: '1' },
      providerCapabilitiesDigest: 'sha256:' + '4'.repeat(64),
      planDigest: 'sha256:' + '3'.repeat(64),
      targetSkillDigest,
      caseCorpusDigest,
      runtimeInputs: [],
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
        stdoutDigest: digest(stdout),
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
