import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

async function materializeHandoffFiles(workspaceFiles) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'eval-audit-handoff-contract-'));
  for (const [relative, contents] of Object.entries(workspaceFiles)) {
    const destination = path.join(temporary, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  return temporary;
}

async function runEval(args, cwd) {
  const bin = path.resolve(sourceRoot, '../../packages/agent-skill-eval/dist/bin.js');
  return execFileAsync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
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
      'quality-review-result-schema',
      'review-dimensions',
      'review-publication-reference',
      'skill-design-brief-schema',
      'skill-rules',
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
    ['agent-content-toolkit:content-rules'],
  );
  assert.deepEqual(
    manifest.buildConfig.skillRuntimeFiles
      .flatMap((entry) => entry.import ? [`${entry.import.plugin}:${entry.import.export}`] : [])
      .sort(),
    [],
  );
  if (!context) return;
  const reviewRoot = path.join(runtimeRoot, 'skills/review-agent-skill');
  for (const relative of [
    'assets/review-input-bundle.schema.json',
    'assets/review-result.schema.json',
    'assets/skill-inspection-result.schema.json',
    'assets/eval-execution-plan.schema.json',
    'assets/eval-audit-result.schema.json',
    'assets/eval-run-bundle.schema.json',
    'scripts/corpus-digest.mjs',
    'scripts/eval-run-bundle-validator.mjs',
    'scripts/validate-eval-audit-result.mjs',
    'scripts/validate-eval-run-bundle.mjs',
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

test('materialized EvalAudit template validates against the canonical v1 schema', async () => {
  if (!context) return;
  const validator = path.join(sourceRoot, 'scripts/validate-json-contract.mjs');
  const templatePath = path.join(
    runtimeRoot,
    'skills/audit-agent-skill-evals/assets/eval-audit-template.json',
  );
  const schemaPath = path.resolve(
    sourceRoot,
    '../../packages/agent-skill-eval/schemas/eval-audit.schema.json',
  );
  const { stdout } = await execFileAsync(process.execPath, [
    validator, schemaPath, templatePath, '--format', 'json',
  ], {
    cwd: runtimeRoot,
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(stdout).valid, true);
});

test('Auditor copies the public provider digest receipt without owning its algorithm', async () => {
  const roots = [sourceRoot];
  if (context) roots.push(runtimeRoot);
  // Static contract exception: an Auditor that reimplements provider digest logic can admit a stale provider binding; behavior test is not suitable because this is a direct Agent instruction about the public machine receipt owner.
  for (const root of roots) {
    const skill = await readFile(
      path.join(root, 'skills/audit-agent-skill-evals/SKILL.md'),
      'utf8',
    );
    assert.match(skill, /calculated\.providerDigest/u);
    assert.match(skill, /不得复制或推导其算法/u);
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
    tags: ['regression', 'catalog-routing'],
    input: {
      query: 'Review this Catalog composition without changing it.',
      expected: { loadedSkills: ['review-aw-catalog'] },
    },
    audit: {
      rationale: 'A Catalog composition review has one exact owner.',
      allowedVariance: 'The route may explain the boundary but must load only the owner.',
      minimalCounterexample: 'A Catalog write request routes to the Catalog Author.',
    },
  };
  const document = {
    version: 1,
    suite: {
      kind: 'trigger',
      unitUnderTest: 'audit-agent-skill-evals',
      participants: ['review-aw-catalog'],
      policy: {
        optimization: 'precision-first',
        falseNegativeCost: 'high',
        falsePositiveCost: 'critical',
        rationale: 'Sibling co-load crosses a critical ownership boundary.',
      },
      runtime: { isolation: 'strict' },
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
      suite: { ...document.suite, kind: 'conversation' },
      cases: [routeCase],
    }));
    await assert.rejects(
      execFileAsync(process.execPath, [
        validator, behaviorPath, '--strict', '--format', 'json',
      ], { encoding: 'utf8' }),
      (error) => {
        const result = JSON.parse(error.stdout);
        return result.diagnostics.some((entry) =>
          entry.code === 'case.conversation-prompt' && entry.level === 'error') &&
          result.diagnostics.some((entry) =>
            entry.code === 'case.conversation-assertions' && entry.level === 'error');
      },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('EvalAudit v1 rejects removed v3 result fields', async () => {
  if (!context) return;
  const validator = path.join(sourceRoot, 'scripts/validate-json-contract.mjs');
  const templatePath = path.join(
    runtimeRoot,
    'skills/audit-agent-skill-evals/assets/eval-audit-template.json',
  );
  const schemaPath = path.resolve(
    sourceRoot,
    '../../packages/agent-skill-eval/schemas/eval-audit.schema.json',
  );
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'eval-audit-v1-contract-'));
  try {
    const audit = JSON.parse(await readFile(templatePath, 'utf8'));
    audit.schemaVersion = 3;
    audit.runBundleDigest = 'sha256:' + '1'.repeat(64);
    const auditPath = path.join(temporary, 'legacy-audit.json');
    await writeFile(auditPath, JSON.stringify(audit));

    await assert.rejects(
      execFileAsync(process.execPath, [validator, schemaPath, auditPath, '--format', 'json'], {
        cwd: runtimeRoot,
        encoding: 'utf8',
      }),
      (error) => {
        const errors = JSON.parse(error.stdout).errors;
        assert.ok(errors.some((entry) => entry === '$: unknown property schemaVersion'));
        assert.ok(errors.some((entry) => entry === '$: unknown property runBundleDigest'));
        return true;
      },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('nested Audit handoff fixtures reach their intended binding states', async () => {
  const cases = JSON.parse(await readFile(
    path.join(sourceRoot, 'skills/audit-agent-skill-evals/evals/behavior-cases.json'),
    'utf8',
  )).cases;
  const stale = cases.find((entry) => entry.id === 'invalid-bundle-or-stale-binding-is-rejected');
  const triage = cases.find((entry) => entry.id === 'triage-separates-provider-harness-and-skill-evidence');
  assert.ok(stale);
  assert.ok(triage);

  for (const entry of [stale, triage]) {
    const temporary = await materializeHandoffFiles(entry.input.workspaceFiles);
    try {
      const prefix = 'handoff';
      const specPath = path.join(temporary, prefix, 'spec.json');
      const auditPath = path.join(temporary, prefix, 'audit.json');
      const resultPath = path.join(temporary, prefix, 'result.json');
      assert.equal(JSON.parse((await runEval(['spec', 'validate', specPath], temporary)).stdout).valid, true);
      assert.equal(JSON.parse((await runEval([
        'audit', 'validate', auditPath, '--spec', specPath,
      ], temporary)).stdout).valid, true);
      if (entry.id === stale.id) {
        await assert.rejects(
          runEval(['result', 'validate', resultPath, '--spec', specPath, '--audit', auditPath], temporary),
          (error) => JSON.parse(error.stdout).errors.includes('Result auditDigest does not match its binding'),
        );
      } else {
        assert.equal(JSON.parse((await runEval([
          'result', 'validate', resultPath, '--spec', specPath, '--audit', auditPath,
        ], temporary)).stdout).valid, true);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
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

test('starter author contract remains valid', async () => {
  if (!context) return;
  const validator = path.join(runtimeRoot, 'skills/author-agent-skill/scripts/validate-json-contract.mjs');
  for (const [schema, value] of [
    [
      'skills/author-agent-skill/assets/skill-design-brief.schema.json',
      'skills/author-agent-skill/assets/skill-design-brief.template.json',
    ],
  ]) {
    await execFileAsync(process.execPath, [validator, path.join(runtimeRoot, schema), path.join(runtimeRoot, value)], {
      cwd: runtimeRoot,
      encoding: 'utf8',
    });
  }
});
