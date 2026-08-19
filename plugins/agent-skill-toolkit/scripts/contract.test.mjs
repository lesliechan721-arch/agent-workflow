import { createHash } from 'node:crypto';
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

test('generic toolkit surfaces do not depend on optional project adapters', async () => {
  const included = (filePath) => {
    const relative = path.relative(pluginRoot, filePath).split(path.sep).join('/');
    return relative.startsWith('standards/')
      || relative.startsWith('schemas/')
      || relative.endsWith('/SKILL.md')
      || relative.endsWith('/README.md')
      || relative.endsWith('/agents/openai.yaml')
      || relative.endsWith('/evals/trigger-cases.json')
      || relative.endsWith('.generated.md');
  };
  const forbidden = [
    ['agent-workflows', /\bagent-workflows\b/u],
    ['aw-plugin-development', /\baw-plugin-development\b/u],
    ['author-aw-plugin', /\bauthor-aw-plugin\b/u],
    ['review-aw-plugin', /\breview-aw-plugin\b/u],
  ];
  const violations = [];
  for (const filePath of (await collectFiles(pluginRoot)).filter(included)) {
    const content = await readFile(filePath, 'utf8');
    for (const [name, pattern] of forbidden) {
      if (pattern.test(content)) violations.push(`${path.relative(pluginRoot, filePath)} names optional adapter ${name}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('generated Skill standards and contract assets are current', async () => {
  await run('scripts/validate-standard-views.mjs');
  await run('scripts/validate-contract-assets.mjs');
});

test('Skill standards extend canonical content rules without redefining them', async () => {
  const contentPath = path.resolve(pluginRoot, '..', 'agent-content-toolkit', 'standards', 'rules.json');
  const [contentRaw, skillSource, manifest] = await Promise.all([
    readFile(contentPath, 'utf8'),
    readFile(path.join(pluginRoot, 'standards', 'skill-rules.json'), 'utf8').then(JSON.parse),
    readFile(path.join(pluginRoot, 'standards', 'rules.json'), 'utf8').then(JSON.parse),
  ]);
  const contentSource = JSON.parse(contentRaw);
  const canonicalIds = new Set(contentSource.rules.map((rule) => rule.id));
  assert.deepEqual(skillSource.rules.filter((rule) => canonicalIds.has(rule.id)), []);
  for (const extension of skillSource.contentRuleExtensions) {
    assert.ok(canonicalIds.has(extension.id), `unknown content rule extension ${extension.id}`);
    assert.deepEqual(
      Object.keys(extension).filter((key) => key !== 'id' && !['skill_author', 'skill_review', 'eval_design', 'eval_audit'].includes(key)),
      [],
    );
  }
  const digest = 'sha256:' + createHash('sha256').update(contentRaw).digest('hex');
  assert.equal(skillSource.contentRuleSource.digest, digest);
  assert.equal(manifest.contentRules.digest, digest);
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

test('owned contract schemas use the agent-skill-toolkit namespace and release version', async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.version, '0.3.0');
  const expected = new Map([
    ['skill-design-brief.schema.json', 'https://agent-skill-toolkit.invalid/schemas/skill-design-brief.schema.json'],
    ['eval-audit-result.schema.json', 'https://agent-skill-toolkit.invalid/schemas/eval-audit-result.schema.json'],
  ]);
  for (const [name, id] of expected) {
    const schema = JSON.parse(await readFile(path.join(pluginRoot, 'schemas', name), 'utf8'));
    assert.equal(schema.$id, id);
  }
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

function finding(id, severity, evidenceTypes) {
  const strong = ['P0', 'P1'].includes(severity);
  return {
    id,
    severity,
    evidenceTypes,
    evidence: ['fixture evidence'],
    location: 'SKILL.md:1',
    claim: 'fixture claim',
    premises: strong ? [{ claim: 'premise', source: 'fixture', evidence: 'fixture', status: 'supported' }] : [],
    reachability: { kind: 'entry-gate', status: strong ? 'supported' : 'unknown', path: 'fixture path', evidence: 'fixture' },
    impact: 'fixture impact',
    counterevidence: strong ? ['fixture counterevidence'] : [],
    owner: 'Skill',
    action: 'fixture action',
    validation: 'fixture validation',
    dimension: 'scope_composition',
  };
}
async function compositionResult(item, design, releaseReadiness) {
  const value = JSON.parse(await readFile(path.join(pluginRoot, 'skills/review-agent-skill/assets/review-result-template.json'), 'utf8'));
  value.composition = 'overloaded';
  value.compositionFindingIds = [item.id];
  value.findings = [item];
  value.design = design;
  value.releaseReadiness = releaseReadiness;
  return value;
}
async function validateFixture(value, prefix) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(temporaryRoot);
  const valuePath = path.join(temporaryRoot, 'review-result.json');
  await writeFile(valuePath, JSON.stringify(value), 'utf8');
  return { valuePath, output: () => run('scripts/validate-review-result.mjs', [valuePath, '--format', 'json']) };
}

test('P2-only overloaded composition resolves to needs-fixes, not redesign', async () => {
  const fixture = await validateFixture(await compositionResult(finding('F-P2', 'P2', ['official-guidance']), 'needs-fixes', 'not-assessed'), 'skill-toolkit-p2-');
  assert.equal(JSON.parse((await fixture.output()).stdout).valid, true);
});

test('P1-linked overloaded composition requires redesign', async () => {
  const fixture = await validateFixture(await compositionResult(finding('F-P1', 'P1', ['structural']), 'redesign', 'blocked'), 'skill-toolkit-p1-');
  assert.equal(JSON.parse((await fixture.output()).stdout).valid, true);
});

test('official-guidance alone cannot support P0 or P1', async () => {
  const fixture = await validateFixture(await compositionResult(finding('F-GUIDANCE', 'P1', ['official-guidance']), 'redesign', 'blocked'), 'skill-toolkit-guidance-');
  await assert.rejects(fixture.output(), /Command failed/u);
});

test('ReviewResult cannot use an unlinked heuristic composition verdict to force redesign', async () => {
  const value = JSON.parse(await readFile(path.join(pluginRoot, 'skills/review-agent-skill/assets/review-result-template.json'), 'utf8'));
  value.composition = 'overloaded';
  value.design = 'redesign';
  const fixture = await validateFixture(value, 'skill-toolkit-unlinked-');
  await assert.rejects(fixture.output(), /Command failed/u);
});

test('full ReviewResult uses all canonical dimensions and linked findings', async () => {
  const [value, rules] = await Promise.all([
    readFile(path.join(pluginRoot, 'skills/review-agent-skill/assets/review-result-template.json'), 'utf8').then(JSON.parse),
    readFile(path.join(pluginRoot, 'standards/review-result-rules.generated.json'), 'utf8').then(JSON.parse),
  ]);
  value.mode = 'full'; value.design = 'pass'; value.releaseReadiness = 'provisional';
  value.complexity = 'proportionate'; value.composition = 'coherent'; value.reducibility = 'minor';
  value.compositionFindingIds = []; value.complexityFindingIds = [];
  value.dimensions = rules.dimensions.map((dimension) => ({ id: dimension.id, weight: dimension.weight, score: 5, confidence: 'high', findingIds: [], unknownIds: [] }));
  value.weightedScore = 100; value.coverage = 100; value.confidence = 'high';
  const fixture = await validateFixture(value, 'skill-toolkit-full-');
  assert.equal(JSON.parse((await fixture.output()).stdout).valid, true);
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
