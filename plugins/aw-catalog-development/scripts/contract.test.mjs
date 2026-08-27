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

  // Static contract exception: these final installed instructions directly authorize or prohibit remote publication; a deterministic test cannot execute a model routing decision safely.
  assert.match(author, /交给 `author-aw-plugin`/u);
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

test('eval corpus covers delegation, routing, review scope, and publication authorization', async () => {
  const cases = await Promise.all([
    ['author-aw-catalog', 'trigger-cases.json'],
    ['author-aw-catalog', 'behavior-cases.json'],
    ['review-aw-catalog', 'trigger-cases.json'],
    ['review-aw-catalog', 'behavior-cases.json'],
    ['publish-aw-catalog', 'trigger-cases.json'],
    ['publish-aw-catalog', 'behavior-cases.json'],
  ].map(async ([skill, file]) => JSON.parse(await readFile(
    path.join(sourceRoot, 'skills', skill, 'evals', file),
    'utf8',
  ))));
  const ids = cases.flatMap((entry) => (entry.cases ?? entry.evals).map(({ id }) => id));
  for (const id of [
    'lifecycle_change_routes_to_plugin_author',
    'add-plugin-delegate-then-aggregate',
    'composition-review-does-not-cross-boundary',
    'preflight-exact-authorization-and-no-retry',
  ]) assert.ok(ids.includes(id), `missing eval case ${id}`);
});
