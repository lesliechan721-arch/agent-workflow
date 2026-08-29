import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginContext = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = pluginContext?.sourceRoot ?? pluginRoot;
const runtimeRoot = pluginContext?.platform
  ? path.join(pluginRoot, pluginContext.platform)
  : pluginRoot;
const awEntry = path.resolve(sourceRoot, '..', '..', 'packages', 'cli', 'dist', 'index.js');

async function runAw(args, cwd = runtimeRoot) {
  const { stdout } = await execFileAsync(process.execPath, [awEntry, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function readSkillFiles(skillName) {
  const root = path.join(runtimeRoot, 'skills', skillName);
  const referencesRoot = path.join(root, 'references');
  const references = (await readdir(referencesRoot))
    .filter((entry) => entry.endsWith('.md'))
    .sort();
  return {
    root,
    skill: await readFile(path.join(root, 'SKILL.md'), 'utf8'),
    readme: await readFile(path.join(root, 'README.md'), 'utf8'),
    references: await Promise.all(references.map(async (entry) => ({
      entry,
      content: await readFile(path.join(referencesRoot, entry), 'utf8'),
    }))),
  };
}

test('AW author references are reachable from the installed Skill entrypoint', async () => {
  const { root, skill } = await readSkillFiles('author-aw-plugin');
  const referencesRoot = path.join(root, 'references');
  const linked = [...skill.matchAll(/references\/([a-z0-9-]+\.md)/gu)]
    .map((match) => match[1])
    .filter((entry) => entry !== undefined)
    .sort();
  const published = (await readdir(referencesRoot))
    .filter((entry) => entry.endsWith('.md'))
    .sort();

  assert.deepEqual([...new Set(linked)], published);
  await Promise.all(published.map((entry) => access(path.join(referencesRoot, entry))));
});

test('installed Skills pass the public AW self-check receipt', async () => {
  for (const skillName of ['author-aw-plugin', 'review-aw-plugin', 'review-aw-workflow']) {
    const result = await runAw([
      'self', 'check', '--from', path.join(runtimeRoot, 'skills', skillName), '--json',
    ]);
    assert.equal(result.command, 'self:check');
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingCapabilities, []);
  }
});

test('AW requirements receipt combines derived, detected, and dynamic authoring capabilities', async () => {
  const result = await runAw(['plugin', 'requirements', sourceRoot, '--json'], sourceRoot);

  assert.equal(result.command, 'plugin:requirements');
  assert.deepEqual(result.declared, ['aw.plugin-authoring.v1']);
  assert.deepEqual(result.unsupportedByCurrentAw, []);
  for (const capability of [
    'aw.catalog-context.v1',
    'aw.plugin-authoring.v1',
    'aw.self-check.v1',
    'aw.skill-validation.v1',
  ]) assert.ok(result.effective.includes(capability));
  assert.ok(result.observations.some((entry) => (
    entry.code === 'aw-command-dynamic'
      && entry.path === 'scripts/check-aw-plugin-release.mjs'
  )));
});

test('runtime capability lookup is a public JSON receipt', async () => {
  const result = await runAw(['plugin', 'capabilities', '--json']);

  assert.equal(result.command, 'plugin:capabilities');
  assert.equal(result.schemaVersion, 1);
  assert.equal(typeof result.capabilities, 'object');
  assert.ok(Object.keys(result.capabilities).length > 0);
});

test('the author bundle has no duplicate AW config helper or private repository contract', async () => {
  const author = await readSkillFiles('author-aw-plugin');
  await assert.rejects(access(path.join(author.root, 'assets', 'aw-config.mjs')));

  const documents = [
    author.skill,
    author.readme,
    ...author.references.map((entry) => entry.content),
    ...(await Promise.all(['review-aw-plugin', 'review-aw-workflow'].map(async (skillName) => {
      const skill = await readSkillFiles(skillName);
      return [skill.skill, skill.readme, ...skill.references.map((entry) => entry.content)];
    }))).flat(),
  ];
  for (const document of documents) {
    assert.equal(document.includes('packages/cli'), false);
    assert.equal(document.includes('agent-workflows'), false);
  }
});

test('plugin review allows only the read-only Catalog context receipt', async () => {
  const reviewer = await readSkillFiles('review-aw-plugin');
  const boundary = reviewer.skill.split('## 边界\n\n', 2)[1];

  assert.ok(boundary, 'review skill must retain its boundary section');
  assert.match(boundary, /`aw catalog context --json` 是唯一允许的 Catalog 命令/u);
  for (const command of [
    'Catalog mutation',
    '`catalog build`',
    '`catalog status`',
    '`catalog validate`',
    '`catalog publish`',
  ]) {
    assert.ok(boundary.includes(command), `boundary must forbid ${command}`);
  }
});
