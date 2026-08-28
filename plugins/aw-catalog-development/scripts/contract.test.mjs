import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = context?.sourceRoot ?? localRoot;
const runtimeRoot = context?.platform ? path.join(localRoot, context.platform) : localRoot;
const expectedDetectedCapabilities = [
  'aw.catalog-authoring.v1',
  'aw.catalog-context.v1',
  'aw.catalog-dev-source.v1',
  'aw.catalog-publication.v1',
  'aw.plugin-authoring.v1',
  'aw.self-check.v1',
];
const execFileAsync = promisify(execFile);

async function readRuntimeSkill(skill, relative = 'SKILL.md') {
  return readFile(path.join(runtimeRoot, 'skills', skill, relative), 'utf8');
}

function commandLines(skill) {
  return skill.match(/^aw .+$/gmu) ?? [];
}

async function readRequirementsReceipt() {
  const repoRoot = path.resolve(sourceRoot, '..', '..');
  const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliEntry,
    'plugin',
    'requirements',
    sourceRoot,
    '--workspace-root',
    repoRoot,
    '--json',
  ], { cwd: repoRoot });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

test('manifest keeps only scanner-derived Catalog capability requirements', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.agents-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.name, 'aw-catalog-development');
  assert.deepEqual(manifest.dependencies, ['aw-plugin-development']);

  const requirements = await readRequirementsReceipt();
  assert.deepEqual(requirements.declared, []);
  assert.deepEqual(requirements.detected, expectedDetectedCapabilities);
  assert.ok(expectedDetectedCapabilities.every((capability) => requirements.effective.includes(capability)));
  assert.deepEqual(requirements.unsupportedByCurrentAw, []);

  const pluginDevelopment = JSON.parse(await readFile(
    path.join(sourceRoot, '..', 'aw-plugin-development', '.agents-plugin', 'plugin.json'),
    'utf8',
  ));
  assert.equal(pluginDevelopment.dependencies.includes('aw-catalog-development'), false);
});

test('each Skill starts its AW workflow with the runtime compatibility check', async () => {
  const skills = await Promise.all([
    readRuntimeSkill('author-aw-catalog'),
    readRuntimeSkill('review-aw-catalog'),
    readRuntimeSkill('publish-aw-catalog'),
  ]);

  // Static contract exception: an installed Skill must stop before an unsupported AW command; behavior test is not suitable because this test only receives the final instruction package, not a model tool session.
  for (const skill of skills) {
    assert.equal(commandLines(skill)[0], 'aw self check --from <skill-root> --json');
    assert.match(skill, /missingCapabilities/u);
    assert.match(skill, /不添加 `--require`/u);
  }
});

test('Catalog author uses context and Catalog development-source commands', async () => {
  const author = await readRuntimeSkill('author-aw-catalog');

  // Static contract exception: these installed commands prevent a Catalog author from mutating a generic source; behavior test is not suitable because source mutation is intentionally outside this deterministic package test.
  assert.match(author, /aw catalog context --json/u);
  assert.match(author, /initialization\.suggestedRoot/u);
  assert.match(author, /aw catalog dev activate --workspace-root <workspace\.root> --json/u);
  assert.match(author, /catalog dev status/u);
  assert.match(author, /catalog dev deactivate/u);
  assert.doesNotMatch(author, /aw catalog source/u);
  assert.match(author, /受影响插件及其反向依赖闭包/u);
  assert.match(author, /aw catalog build --workspace-root <workspace\.root> --json/u);
  assert.match(author, /aw catalog validate <workspace\.root>\/\.aw\/catalog --json/u);
});

test('Catalog reviewer only consumes static context, status, and an existing snapshot', async () => {
  const reviewer = await readRuntimeSkill('review-aw-catalog');

  // Static contract exception: these installed prohibitions preserve the Review read-only boundary; behavior test is not suitable because executing a prohibited command would itself violate that boundary.
  assert.match(reviewer, /aw catalog context --json/u);
  assert.match(reviewer, /aw catalog status --workspace-root <workspace\.root> --json/u);
  assert.match(reviewer, /absent.*current.*stale.*invalid/u);
  assert.match(reviewer, /aw catalog validate <snapshot\.path> --json/u);
  assert.match(reviewer, /不运行 plugin test\/build、catalog build、`catalog status --preflight`、publish 或其它 mutation/u);
});

test('Catalog publisher preflights and binds the user authorization to the receipt', async () => {
  const [publisher, metadata] = await Promise.all([
    readRuntimeSkill('publish-aw-catalog'),
    readRuntimeSkill('publish-aw-catalog', 'agents/openai.yaml'),
  ]);

  // Static contract exception: the final publication command and receipt fields are user-facing authorization controls; behavior test is not suitable because it would perform remote publication.
  assert.doesNotMatch(publisher, /^disable-model-invocation:/mu);
  assert.match(metadata, /^\s*allow_implicit_invocation: true$/mu);
  assert.match(publisher, /普通修改、build、验证或只读 Review 不使用/u);
  assert.match(publisher, /aw catalog context --json/u);
  assert.match(publisher, /--workspace-root <user\.root>/u);
  assert.match(publisher, /--remote <user\.remote>/u);
  assert.match(publisher, /--branch <user\.branch>/u);
  assert.match(publisher, /aw catalog context --workspace-root <selected\.workspaceRoot>/u);
  assert.match(publisher, /--remote <selected\.remote> --branch <selected\.branch> --json/u);
  assert.match(publisher, /丢弃先前 context receipt，只消费这个新 receipt/u);
  assert.match(publisher, /--workspace-root <context\.workspace\.root>/u);
  assert.match(publisher, /--remote <context\.publication\.remote>/u);
  assert.match(publisher, /--branch <context\.publication\.branch> --preflight --json/u);
  assert.match(publisher, /绝对 `workspace\.root`、`publication\.remote`、`publication\.branch` 和 `publication\.descriptorDigest`/u);
  assert.match(publisher, /仅对这一次 identity 明确授权/u);
  assert.match(publisher, /--workspace-root <preflight\.workspace\.root>/u);
  assert.match(publisher, /--remote <preflight\.publication\.remote>/u);
  assert.match(publisher, /--branch <preflight\.publication\.branch>/u);
  assert.match(publisher, /--expected-descriptor-digest <preflight\.publication\.descriptorDigest>/u);
  assert.match(publisher, /Catalog 不重试或 repair 同一 version/u);
  assert.doesNotMatch(publisher, /--branch catalog/u);
});
