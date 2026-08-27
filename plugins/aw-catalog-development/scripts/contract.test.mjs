import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = context?.sourceRoot ?? localRoot;
const runtimeRoot = context?.platform ? path.join(localRoot, context.platform) : localRoot;

async function readRuntimeSkill(skill, relative = 'SKILL.md') {
  return readFile(path.join(runtimeRoot, 'skills', skill, relative), 'utf8');
}

test('manifest has one-way dependency on the plugin development layer', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.agents-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'aw-catalog-development');
  assert.deepEqual(manifest.dependencies, ['aw-plugin-development']);

  const pluginDevelopment = JSON.parse(await readFile(
    path.join(sourceRoot, '..', 'aw-plugin-development', '.agents-plugin', 'plugin.json'),
    'utf8',
  ));
  assert.equal(pluginDevelopment.dependencies.includes('aw-catalog-development'), false);
});

test('three Skills keep distinct routing and side-effect boundaries', async () => {
  const [author, reviewer, publisher, publishMetadata] = await Promise.all([
    readRuntimeSkill('author-aw-catalog'),
    readRuntimeSkill('review-aw-catalog'),
    readRuntimeSkill('publish-aw-catalog'),
    readRuntimeSkill('publish-aw-catalog', 'agents/openai.yaml'),
  ]);

  // Static contract exception: these final installed instructions directly authorize deletion handoff and prohibit unsafe publication; a deterministic test cannot execute a model routing decision safely.
  assert.match(author, /交给 `author-aw-plugin`/u);
  assert.match(author, /Catalog Author 是唯一直接入口/u);
  assert.match(author, /拥有删除意图和 Workspace 编排/u);
  assert.match(author, /确认其明确给出 `<workspace-root>` 和 `<plugin-name>`/u);
  assert.match(author, /目标的反向依赖/u);
  assert.match(author, /决定删除是否关联 Catalog version/u);
  assert.match(author, /返回结构化 receipt/u);
  assert.match(author, /不新增 tombstone、retirement metadata 或 release ledger/u);
  assert.match(author, /删除成功后不得对已删除目标运行 validate、test、build 或 status/u);
  assert.match(author, /若 inventory 为空，记录 empty inventory/u);
  assert.match(author, /绝不运行 `aw catalog publish`/u);
  assert.match(reviewer, /不得传 `--preflight`/u);
  assert.match(reviewer, /不得运行 plugin build\/test、catalog build\/validate\/publish/u);
  assert.match(publisher, /^disable-model-invocation: true$/mu);
  assert.match(publishMetadata, /^\s*allow_implicit_invocation: false$/mu);
  assert.match(publisher, /--preflight --remote <remote> --branch <branch> --json/u);
  assert.match(publisher, /publication\.remote`、`fetchUrl`、`pushUrl`、`branch`、`parent`、`tag`、`snapshotDigest`、`planId` 和 `descriptorDigest`/u);
  assert.match(publisher, /--expected-descriptor-digest <descriptorDigest> --yes --json/u);
  assert.match(publisher, /明确授权这一个 exact identity/u);
  assert.match(publisher, /不重试同一 Catalog version/u);
});

test('eval corpus covers release routing pairs and publication preflight failure', async () => {
  const skills = ['author-aw-catalog', 'review-aw-catalog', 'publish-aw-catalog'];
  const evalsBySkill = new Map(await Promise.all(skills.map(async (skill) => {
    const evalRoot = path.join(sourceRoot, 'skills', skill, 'evals');
    const [manifest, triggerCases, behaviorCases] = await Promise.all([
      readFile(path.join(evalRoot, 'manifest.json'), 'utf8').then((contents) => JSON.parse(contents)),
      readFile(path.join(evalRoot, 'trigger-cases.json'), 'utf8').then((contents) => JSON.parse(contents)),
      readFile(path.join(evalRoot, 'behavior-cases.json'), 'utf8').then((contents) => JSON.parse(contents)),
    ]);
    return [skill, { manifest, triggerCases, behaviorCases }];
  })));

  for (const [skill, { manifest, triggerCases }] of evalsBySkill) {
    const requiredTriggerSuites = manifest.suites.filter(
      (suite) => suite.kind === 'trigger' && suite.requiredForRelease,
    );
    assert.ok(requiredTriggerSuites.length > 0, `${skill} must have a required trigger suite`);
    for (const suite of requiredTriggerSuites) {
      for (const split of suite.releaseSplits) {
        const releaseCases = triggerCases.cases.filter((entry) => entry.split === split);
        assert.ok(
          releaseCases.some((entry) => entry.should_load_skill === true),
          `${skill} trigger release split ${split} must contain a positive case`,
        );
        assert.ok(
          releaseCases.some((entry) => entry.should_load_skill === false),
          `${skill} trigger release split ${split} must contain a negative case`,
        );
      }
    }
  }

  const ids = [...evalsBySkill.values()].flatMap(({ triggerCases, behaviorCases }) => [
    ...triggerCases.cases,
    ...behaviorCases.evals,
  ].map(({ id }) => id));
  for (const id of [
    'lifecycle_change_routes_to_plugin_author',
    'catalog_dependency_update_requires_aggregation',
    'catalog_dependency_consistency_review',
    'add-plugin-delegate-then-aggregate',
    'composition-review-does-not-cross-boundary',
    'preflight-failure-stops-before-authorization',
  ]) assert.ok(ids.includes(id), `missing eval case ${id}`);
});
