import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
const repositoryRoot = path.resolve(pluginRoot, '..', '..');
const authorScripts = path.join(pluginRoot, 'skills', 'author-aw-plugin', 'scripts');
const reviewScripts = path.join(pluginRoot, 'skills', 'review-aw-plugin', 'scripts');
const validator = path.join(authorScripts, 'validate-json-contract.mjs');
const awSummaryValidator = path.join(pluginRoot, 'scripts', 'validate-aw-review-summary.mjs');
const temporaryRoots = [];

async function run(script, args = [], options = {}) {
  return execFileAsync(process.execPath, [script, ...args], {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test('generated adapter assets are current', async () => {
  await run(path.join(pluginRoot, 'scripts', 'validate-contract-assets.mjs'));
  await run(path.join(authorScripts, 'generate_skill_frontmatter_reference.mjs'), [
    '--check',
    '--repo-root',
    repositoryRoot,
  ]);
});

test('review inspection expands related globs with the CLI production dependency closure', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'aw-review-related-glob-'));
  temporaryRoots.push(temporaryRoot);
  const cleanRepositoryRoot = path.join(temporaryRoot, 'repository');
  const cleanCliRoot = path.join(cleanRepositoryRoot, 'packages', 'cli');
  const cleanNodeModules = path.join(cleanCliRoot, 'node_modules');
  const cliPackage = JSON.parse(await readFile(
    path.join(repositoryRoot, 'packages', 'cli', 'package.json'),
    'utf8',
  ));
  await mkdir(cleanNodeModules, { recursive: true });
  await writeFile(
    path.join(cleanCliRoot, 'package.json'),
    JSON.stringify({ type: 'module', dependencies: cliPackage.dependencies }),
    'utf8',
  );
  for (const dependency of Object.keys(cliPackage.dependencies)) {
    const source = path.join(repositoryRoot, 'packages', 'cli', 'node_modules', dependency);
    const destination = path.join(cleanNodeModules, dependency);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(source, destination, 'junction');
  }
  const targetRoot = path.join(cleanRepositoryRoot, 'target');
  const rolesRoot = path.join(targetRoot, 'roles');
  await mkdir(rolesRoot, { recursive: true });
  await writeFile(path.join(targetRoot, 'SKILL.md'), '---\nname: target\ndescription: target\n---\n', 'utf8');
  await writeFile(path.join(rolesRoot, 'reader.toml'), 'name = "reader"\ninstructions = "Read evidence."\n', 'utf8');

  const result = await run(path.join(reviewScripts, 'inspect-aw-target.mjs'), [
    targetRoot,
    '--repo-root',
    cleanRepositoryRoot,
    '--related',
    path.join(rolesRoot, '*.toml'),
    '--format',
    'json',
  ], { cwd: cleanRepositoryRoot });
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.related_toml.files.map((entry) => entry.path), [
    path.join(rolesRoot, 'reader.toml'),
  ]);
});

test('author adapter keeps README policy inside the plugin bundle', async () => {
  const [skill, readmePolicy] = await Promise.all([
    readFile(path.join(pluginRoot, 'skills', 'author-aw-plugin', 'SKILL.md'), 'utf8'),
    readFile(path.join(pluginRoot, 'skills', 'author-aw-plugin', 'references', 'aw-readme-authoring.md'), 'utf8'),
  ]);
  assert.match(skill, /references\/aw-readme-authoring\.md/u);
  assert.doesNotMatch(skill, /docs\/readme-standard\.md/u);
  assert.match(readmePolicy, /\.agents-plugin\/plugin\.json/u);
  assert.match(readmePolicy, /不依赖宿主工作区的 `docs\/`/u);
});

test('authoring context supports a plugin root outside a conventional plugins directory', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'aw-portable-workspace-'));
  temporaryRoots.push(temporaryRoot);
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  const target = path.join(workspaceRoot, 'packages', 'portable-plugin');
  await mkdir(path.join(target, '.agents-plugin'), { recursive: true });
  await writeFile(path.join(target, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'portable-plugin',
    version: '0.1.0',
    marketplace: { policy: { products: ['CODEX', 'CLAUDE'] } },
  }), 'utf8');

  const script = path.join(authorScripts, 'prepare-aw-authoring-context.mjs');
  const result = await run(script, [
    target,
    '--repo-root',
    workspaceRoot,
    '--component-type',
    'skill',
    '--skill-invocation',
    'claude-model-only',
  ]);
  const context = JSON.parse(result.stdout);
  assert.equal(context.repository, 'workspace');
  assert.equal(context.plugin, 'portable-plugin');
  assert.equal(context.pluginRoot, target);
  assert.equal(context.skillInvocation, 'claude-model-only');
  assert.deepEqual(context.products, ['CLAUDE']);
  assert.deepEqual(context.validators, []);

  const explicit = JSON.parse((await run(script, [
    target,
    '--repo-root',
    workspaceRoot,
    '--validator',
    'node workspace-validator.mjs',
  ])).stdout);
  assert.deepEqual(explicit.validators, ['node workspace-validator.mjs']);
  await assert.rejects(run(script, [target, '--repo-root', workspaceRoot, '--plugin', 'wrong-name']), /does not match/u);
});

test('review bundle treats final artifacts as available material, not completed review stages', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'aw-review-stage-'));
  temporaryRoots.push(temporaryRoot);
  const finalDir = path.join(temporaryRoot, 'final');
  await mkdir(finalDir, { recursive: true });
  await writeFile(path.join(finalDir, 'SKILL.md'), '---\nname: fixture\n---\n', 'utf8');
  const script = path.join(reviewScripts, 'prepare-aw-review-bundle.mjs');
  const result = await run(script, [
    path.join(repositoryRoot, 'plugins', 'agent-content-toolkit'),
    '--source',
    'agent-skill-toolkit=' + path.join(repositoryRoot, 'plugins', 'agent-skill-toolkit'),
    '--final',
    'codex=' + finalDir,
  ]);
  const bundle = JSON.parse(result.stdout);
  assert.equal(bundle.schemaVersion, 2);
  assert.ok(bundle.artifacts.some((artifact) => artifact.role === 'final'));
  assert.deepEqual(bundle.orchestration.providedStages, []);
});

test('review bundle records a validated Eval audit as a bound completed stage', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'aw-review-eval-stage-'));
  temporaryRoots.push(temporaryRoot);
  const casePath = path.join(temporaryRoot, 'cases.json');
  await writeFile(casePath, JSON.stringify({ id: 'case-1', prompt: 'example' }), 'utf8');
  const evalValidator = path.join(reviewScripts, 'validate-eval-audit-result.mjs');
  const corpusDigest = (await run(evalValidator, ['--digest-only', '--case', casePath])).stdout.trim();
  const audit = {
    schemaVersion: 1,
    producer: 'audit-agent-skill-evals',
    independentContext: true,
    auditId: 'audit-1',
    mode: 'preflight',
    corpusDigest,
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
  const result = await run(path.join(reviewScripts, 'prepare-aw-review-bundle.mjs'), [
    path.join(repositoryRoot, 'plugins', 'agent-content-toolkit'),
    '--eval-audit',
    auditPath,
    '--eval-case',
    casePath,
  ]);
  const stage = JSON.parse(result.stdout).orchestration.providedStages[0];
  assert.equal(stage.id, 'eval-audit');
  assert.equal(stage.targetDigest, corpusDigest);
  assert.equal(stage.schema, 'EvalAuditResult');
  assert.equal(stage.independentContext, true);
  assert.match(stage.resultDigest, /^sha256:[0-9a-f]{64}$/u);
});

test('starter adapter documents satisfy their canonical schemas', async () => {
  const pairs = [
    ['schemas/aw-authoring-context.schema.json', 'skills/author-aw-plugin/assets/aw-authoring-context.json'],
    ['schemas/aw-review-summary.schema.json', 'skills/review-aw-plugin/assets/aw-review-summary.json'],
    ['../agent-skill-toolkit/schemas/review-input-bundle.schema.json', 'skills/review-aw-plugin/assets/review-input-bundle.json'],
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
