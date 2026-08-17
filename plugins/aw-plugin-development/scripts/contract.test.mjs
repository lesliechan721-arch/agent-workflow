import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const execFileAsync = promisify(execFile);
const localPluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginContext = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const pluginRoot = pluginContext?.sourceRoot ?? localPluginRoot;
const materializedSkillsRoot = pluginContext
  ? path.join(pluginContext.plugin.rootDir, pluginContext.platform, 'skills')
  : path.join(pluginRoot, 'skills');
const repositoryRoot = path.resolve(pluginRoot, '..', '..');
const authorScripts = path.join(pluginRoot, 'skills', 'author-aw-plugin', 'scripts');
const reviewScripts = path.join(pluginRoot, 'skills', 'review-aw-plugin', 'scripts');
const validator = path.join(authorScripts, 'validate-json-contract.mjs');
const awSummaryValidator = path.join(pluginRoot, 'scripts', 'validate-aw-review-summary.mjs');
const temporaryRoots = [];

async function run(script, args = []) {
  return execFileAsync(process.execPath, [script, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test('generated adapter assets are current', async () => {
  await run(path.join(pluginRoot, 'scripts', 'validate-contract-assets.mjs'));
  await run(path.join(
    authorScripts,
    'generate_skill_frontmatter_reference.mjs',
  ), ['--check', '--repo-root', repositoryRoot]);
});

test('authoring context binds manifest identity and Skill invocation intent', async () => {
  const script = path.join(authorScripts, 'prepare-aw-authoring-context.mjs');
  const target = path.join(repositoryRoot, 'plugins', 'agent-content-toolkit');
  const result = await run(script, [target, '--component-type', 'skill', '--skill-invocation', 'claude-model-only']);
  assert.equal(JSON.parse(result.stdout).skillInvocation, 'claude-model-only');
  assert.deepEqual(JSON.parse(result.stdout).products, ['CLAUDE']);
  await assert.rejects(
    run(script, [target, '--plugin', 'wrong-name']),
    /does not match/u,
  );
});

test('review bundle rejects an empty final path and reports per-file Git currentness', async () => {
  const script = path.join(reviewScripts, 'prepare-aw-review-bundle.mjs');
  await assert.rejects(
    run(script, [path.join(repositoryRoot, 'plugins', 'agent-content-toolkit'), '--final', 'codex=']),
    /non-empty profile and path/u,
  );
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'aw-currentness-'));
  temporaryRoots.push(temporaryRoot);
  const pluginDir = path.join(temporaryRoot, 'plugins', 'fixture');
  await mkdir(path.join(pluginDir, '.agents-plugin'), { recursive: true });
  await writeFile(path.join(pluginDir, '.agents-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture' }), 'utf8');
  await writeFile(path.join(pluginDir, 'clean.txt'), 'clean\n', 'utf8');
  await writeFile(path.join(pluginDir, 'dirty.txt'), 'before\n', 'utf8');
  await execFileAsync('git', ['init'], { cwd: temporaryRoot });
  await execFileAsync('git', ['add', '.'], { cwd: temporaryRoot });
  await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: temporaryRoot });
  await writeFile(path.join(pluginDir, 'dirty.txt'), 'after\n', 'utf8');
  const document = JSON.parse((await run(script, [pluginDir])).stdout);
  const byPath = new Map(document.artifacts.map((artifact) => [artifact.path, artifact.currentness]));
  assert.equal([...byPath].find(([file]) => file.endsWith('/clean.txt'))?.[1], 'current');
  assert.equal([...byPath].find(([file]) => file.endsWith('/dirty.txt'))?.[1], 'dirty');
});

test('materialized AW scripts accept an explicit repository root', async () => {
  const materializedAuthor = path.join(materializedSkillsRoot, 'author-aw-plugin', 'scripts');
  const materializedReview = path.join(materializedSkillsRoot, 'review-aw-plugin', 'scripts');
  await run(path.join(materializedAuthor, 'generate_skill_frontmatter_reference.mjs'), ['--check', '--repo-root', repositoryRoot]);
  await run(path.join(materializedAuthor, 'validate_plugin.mjs'), [
    path.join(repositoryRoot, 'plugins', 'agent-content-toolkit'),
    '--repo-root',
    repositoryRoot,
  ]);
  await run(path.join(materializedReview, 'inspect-aw-target.mjs'), [
    path.join(repositoryRoot, 'plugins', 'agent-content-toolkit'),
    '--repo-root',
    repositoryRoot,
    '--format',
    'json',
  ]);
  await run(path.join(materializedReview, 'run-static-skill-evals.mjs'), [
    'skill-review',
    '--repo-root',
    repositoryRoot,
    '--validate-only',
  ]);
});

test('starter adapter documents satisfy their canonical schemas', async () => {
  const pairs = [
    [
      'schemas/aw-authoring-context.schema.json',
      'skills/author-aw-plugin/assets/aw-authoring-context.json',
    ],
    [
      'schemas/aw-review-summary.schema.json',
      'skills/review-aw-plugin/assets/aw-review-summary.json',
    ],
    [
      '../agent-content-toolkit/schemas/review-input-bundle.schema.json',
      'skills/review-aw-plugin/assets/review-input-bundle.json',
    ],
  ];
  for (const [schema, value] of pairs) {
    await run(validator, [path.join(pluginRoot, schema), path.join(pluginRoot, value)]);
  }
  await run(awSummaryValidator, [
    path.join(pluginRoot, 'skills', 'review-aw-plugin', 'assets', 'aw-review-summary.json'),
  ]);
});

test('AW summary decision must follow generic reviews and project gates', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'aw-summary-'));
  temporaryRoots.push(temporaryRoot);
  const value = JSON.parse(await readFile(
    path.join(pluginRoot, 'skills', 'review-aw-plugin', 'assets', 'aw-review-summary.json'),
    'utf8',
  ));
  value.design = 'pass';
  const valuePath = path.join(temporaryRoot, 'summary.json');
  await writeFile(valuePath, JSON.stringify(value), 'utf8');
  await assert.rejects(run(awSummaryValidator, [valuePath]), /Command failed/u);
});

test('authoring context and review bundle preparers emit valid handoffs', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'aw-plugin-development-'));
  temporaryRoots.push(temporaryRoot);
  const authoring = await run(
    path.join(authorScripts, 'prepare-aw-authoring-context.mjs'),
    [path.join(repositoryRoot, 'plugins', 'agent-content-toolkit'), '--component-type', 'skill'],
  );
  const authoringPath = path.join(temporaryRoot, 'authoring.json');
  await writeFile(authoringPath, authoring.stdout, 'utf8');
  await run(validator, [
    path.join(pluginRoot, 'schemas', 'aw-authoring-context.schema.json'),
    authoringPath,
  ]);

  const bundle = await run(
    path.join(reviewScripts, 'prepare-aw-review-bundle.mjs'),
    [path.join(repositoryRoot, 'plugins', 'agent-content-toolkit')],
  );
  const bundlePath = path.join(temporaryRoot, 'bundle.json');
  await writeFile(bundlePath, bundle.stdout, 'utf8');
  await run(validator, [
    path.join(repositoryRoot, 'plugins', 'agent-content-toolkit', 'schemas', 'review-input-bundle.schema.json'),
    bundlePath,
  ]);
  const document = JSON.parse(bundle.stdout);
  assert.match(document.target.sourceDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(document.artifacts.length > 0);
  assert.ok(document.artifacts.every((artifact) => artifact.owner === 'agent-content-toolkit'));
});
