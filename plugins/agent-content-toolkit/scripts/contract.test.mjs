import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = context?.sourceRoot ?? localRoot;
const bundleRoot = context?.plugin.rootDir ?? localRoot;
const runtimeRoot = context ? path.join(bundleRoot, context.platform) : localRoot;

async function exists(relativeRoot, relative) {
  return access(path.join(relativeRoot, relative)).then(() => true, () => false);
}

test('staged runtime contains fresh generated views and projected contracts', async () => {
  if (context) {
    await execFileAsync(process.execPath, [
      path.join(sourceRoot, 'scripts/generate-standard-views.mjs'),
      '--check',
      '--source-root', sourceRoot,
      '--output-root', runtimeRoot,
    ], { cwd: context.cwd, encoding: 'utf8' });
  }

  const canonicalPairs = [
    [
      'schemas/reference-audit-result.schema.json',
      'skills/review-agent-content/assets/reference-audit-result.schema.json',
    ],
    [
      'scripts/validate-json-contract.mjs',
      'skills/review-agent-content/scripts/validate-json-contract.mjs',
    ],
  ];
  for (const [source, target] of canonicalPairs) {
    const [sourceRaw, runtimeRaw] = await Promise.all([
      readFile(path.join(sourceRoot, source)),
      readFile(path.join(runtimeRoot, target)),
    ]);
    assert.equal(
      createHash('sha256').update(runtimeRaw).digest('hex'),
      createHash('sha256').update(sourceRaw).digest('hex'),
      `${target} must be projected from ${source}`,
    );
  }

  await execFileAsync(process.execPath, [
    path.join(runtimeRoot, 'skills/review-agent-content/scripts/validate-json-contract.mjs'),
    path.join(runtimeRoot, 'skills/review-agent-content/assets/reference-audit-result.schema.json'),
    path.join(runtimeRoot, 'skills/review-agent-content/assets/reference-audit-result.template.json'),
  ], { cwd: context?.cwd ?? runtimeRoot, encoding: 'utf8' });
});

test('source keeps canonical files and excludes runtime projections', async () => {
  const forbidden = [
    'skills/write-agent-content/references/writing-standard.generated.md',
    'skills/review-agent-content/references/review-standard.generated.md',
    'skills/review-agent-content/assets/reference-audit-result.schema.json',
    'skills/review-agent-content/scripts/validate-json-contract.mjs',
  ];
  for (const relative of forbidden) {
    assert.equal(await exists(sourceRoot, relative), false, `${relative} must not exist in source`);
  }
});

test('cacheable standard render is deterministic across undeclared environment changes', async () => {
  async function render(marker) {
    const outputRoot = await mkdtemp(path.join(tmpdir(), 'content-standard-render-'));
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        path.join(sourceRoot, 'scripts/generate-standard-views.mjs'),
        '--source-root', sourceRoot,
        '--output-root', outputRoot,
      ], {
        cwd: context?.cwd ?? sourceRoot,
        env: { ...process.env, AW_PLUGIN_TEST_UNDECLARED: marker },
        encoding: 'utf8',
      });
      const { targets } = JSON.parse(stdout);
      return Promise.all(
        targets.map(async (relative) => [
          relative,
          createHash('sha256').update(await readFile(path.join(outputRoot, relative))).digest('hex'),
        ]),
      );
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  }
  assert.deepEqual(await render('first'), await render('second'));
});

test('staged manifest publishes the content toolkit 0.6.0 contract', async () => {
  const stagedManifest = JSON.parse(
    await readFile(path.join(bundleRoot, '.agents-plugin/plugin.json'), 'utf8'),
  );
  const sourceManifest = JSON.parse(
    await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'),
  );
  assert.equal(stagedManifest.name, 'agent-content-toolkit');
  assert.equal(stagedManifest.version, '0.6.0');
  assert.equal(sourceManifest.buildConfig.cacheable, true);
  assert.deepEqual(
    sourceManifest.buildConfig.runtimeExports.map(({ name }) => name).sort(),
    ['content-rules', 'reference-audit-result-schema'],
  );
});
