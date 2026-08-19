import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const temporaryRoots = [];

async function run(relative, args = []) {
  return execFileAsync(process.execPath, [path.join(pluginRoot, relative), ...args], {
    cwd: pluginRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test('generic Skill surfaces do not depend on optional project adapters', async () => {
  const skillsRoot = path.join(pluginRoot, 'skills');
  const publicSurface = (filePath) => {
    const relative = path.relative(skillsRoot, filePath).split(path.sep).join('/');
    return relative.endsWith('/SKILL.md')
      || relative.endsWith('/README.md')
      || relative.endsWith('/agents/openai.yaml')
      || relative.endsWith('/evals/trigger-cases.json');
  };
  const forbidden = [
    ['agent-workflows', /\bagent-workflows\b/u],
    ['aw-plugin-development', /\baw-plugin-development\b/u],
    ['author-aw-plugin', /\bauthor-aw-plugin\b/u],
    ['review-aw-plugin', /\breview-aw-plugin\b/u],
  ];
  const violations = [];
  for (const filePath of (await collectFiles(skillsRoot)).filter(publicSurface)) {
    const content = await readFile(filePath, 'utf8');
    for (const [name, pattern] of forbidden) {
      if (pattern.test(content)) {
        violations.push(`${path.relative(pluginRoot, filePath)} names optional upstream adapter ${name}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('generated Skill standards and contract assets are current', async () => {
  await run('scripts/validate-standard-views.mjs');
  await run('scripts/validate-contract-assets.mjs');
});

test('starter documents satisfy canonical schemas', async () => {
  const validator = 'scripts/validate-json-contract.mjs';
  const pairs = [
    ['schemas/skill-design-brief.schema.json', 'skills/author-agent-skill/assets/skill-design-brief.template.json'],
    ['schemas/eval-audit-result.schema.json', 'skills/audit-agent-skill-evals/assets/eval-audit-result-template.json'],
  ];
  for (const [schema, value] of pairs) await run(validator, [schema, value]);
  await run('scripts/validate-review-result.mjs', ['skills/review-agent-skill/assets/review-result-template.json']);
  await run('scripts/validate-eval-audit-result.mjs', ['skills/audit-agent-skill-evals/assets/eval-audit-result-template.json']);
});

test('ReviewInputBundle stage records bind actual stage result artifacts', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'skill-toolkit-stage-'));
  temporaryRoots.push(temporaryRoot);
  const value = {
    schemaVersion: 2,
    target: { kind: 'agent-skill', name: 'fixture', sourceDigest: 'sha256:' + '1'.repeat(64) },
    artifacts: [],
    environment: {},
    orchestration: {
      stageOwner: 'caller',
      providedStages: [{
        id: 'reference-audit', producer: 'review-agent-content', independentContext: true,
        targetDigest: 'sha256:' + '2'.repeat(64), resultPath: 'handoff/reference-audit-result.json',
        resultDigest: 'sha256:' + '3'.repeat(64), schema: 'ReferenceAuditResult',
      }],
    },
    evalAudit: null,
    evalResults: [],
  };
  const valuePath = path.join(temporaryRoot, 'bundle.json');
  await writeFile(valuePath, JSON.stringify(value), 'utf8');
  await run('scripts/validate-json-contract.mjs', ['schemas/review-input-bundle.schema.json', valuePath]);
  value.orchestration.providedStages[0].resultPath = '';
  await writeFile(valuePath, JSON.stringify(value), 'utf8');
  await assert.rejects(run('scripts/validate-json-contract.mjs', ['schemas/review-input-bundle.schema.json', valuePath]), /Command failed/u);
});

test('ReviewResult cannot use an unlinked heuristic composition verdict to force redesign', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'skill-toolkit-composition-'));
  temporaryRoots.push(temporaryRoot);
  const value = JSON.parse(await readFile(path.join(pluginRoot, 'skills/review-agent-skill/assets/review-result-template.json'), 'utf8'));
  value.composition = 'overloaded';
  value.design = 'redesign';
  const valuePath = path.join(temporaryRoot, 'review-result.json');
  await writeFile(valuePath, JSON.stringify(value), 'utf8');
  await assert.rejects(run('scripts/validate-review-result.mjs', [valuePath]), /Command failed/u);
});

test('full ReviewResult uses all canonical dimensions and linked findings', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'skill-toolkit-full-'));
  temporaryRoots.push(temporaryRoot);
  const [value, rules] = await Promise.all([
    readFile(path.join(pluginRoot, 'skills/review-agent-skill/assets/review-result-template.json'), 'utf8').then(JSON.parse),
    readFile(path.join(pluginRoot, 'standards/rules.json'), 'utf8').then(JSON.parse),
  ]);
  value.mode = 'full'; value.design = 'pass'; value.releaseReadiness = 'provisional';
  value.complexity = 'proportionate'; value.composition = 'coherent'; value.reducibility = 'minor';
  value.compositionFindingIds = []; value.complexityFindingIds = [];
  value.dimensions = rules.dimensions.map((dimension) => ({ id: dimension.id, weight: dimension.weight, score: 5, confidence: 'high', findingIds: [], unknownIds: [] }));
  value.weightedScore = 100; value.coverage = 100; value.confidence = 'high';
  const valuePath = path.join(temporaryRoot, 'review-result.json');
  await writeFile(valuePath, JSON.stringify(value), 'utf8');
  const result = await run('scripts/validate-review-result.mjs', [valuePath, '--format', 'json']);
  assert.equal(JSON.parse(result.stdout).valid, true);
});

test('inspector detects invalid frontmatter, broken resources, and large references', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'skill-toolkit-inspector-'));
  temporaryRoots.push(temporaryRoot);
  const skillRoot = path.join(temporaryRoot, 'fixture-skill');
  await mkdir(path.join(skillRoot, 'references'), { recursive: true });
  await writeFile(path.join(skillRoot, 'SKILL.md'), ['---', 'name: wrong-name', 'description: review fixture', '---', '# Fixture', 'Read `references/missing.md`.', ''].join('\n'), 'utf8');
  await writeFile(path.join(skillRoot, 'references', 'large.md'), '# Large\n' + 'text\n'.repeat(350), 'utf8');
  await assert.rejects(run('scripts/inspect-agent-skill.mjs', [skillRoot]), /Command failed/u);
  const output = await run('scripts/inspect-agent-skill.mjs', [skillRoot, '--format', 'json']).catch((error) => ({ stdout: error.stdout }));
  const result = JSON.parse(output.stdout);
  assert.ok(result.issues.some((issue) => issue.code === 'name-directory-mismatch'));
  assert.ok(result.issues.some((issue) => issue.code === 'missing-resource'));
  assert.equal(result.references[0].requiresSemanticAudit, true);
});
