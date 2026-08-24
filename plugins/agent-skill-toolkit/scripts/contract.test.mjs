import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function runtimeExportSource(plugin, exportName) {
  const providerRoot = path.resolve(sourceRoot, '..', plugin);
  const manifest = JSON.parse(await readFile(path.join(providerRoot, '.agents-plugin/plugin.json'), 'utf8'));
  const item = manifest.buildConfig?.runtimeExports?.find((entry) => entry.name === exportName);
  assert.ok(item, `missing runtime export ${plugin}:${exportName}`);
  return path.join(providerRoot, item.source);
}

test('reviewer runtime exposes only the lightweight machine contract', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'));
  const targets = manifest.buildConfig.skillRuntimeFiles
    .filter((entry) => entry.skill === 'review-agent-skill')
    .map((entry) => entry.target)
    .sort();
  assert.deepEqual(targets, [
    'assets/review-dimensions.json',
    'assets/review-result-lite.schema.json',
    'scripts/check-agent-skill.mjs',
    'scripts/validate-review-result-lite.mjs',
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

test('generated reviewer view includes full dimensions without release workflow state', async () => {
  const reviewRoot = path.join(runtimeRoot, 'skills/review-agent-skill/references');
  for (const file of ['review-rubric.generated.md', 'composition-fitness.md', 'evidence-and-severity.md']) {
    assert.ok((await readFile(path.join(reviewRoot, file), 'utf8')).length > 100, file);
  }
  for (const file of ['review-dimensions.generated.md', 'scoring-model.generated.md']) {
    assert.ok((await readFile(path.join(reviewRoot, file), 'utf8')).length > 100, file);
  }
  await assert.rejects(readFile(path.join(reviewRoot, 'source-map.generated.md'), 'utf8'));
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
