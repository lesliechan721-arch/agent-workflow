import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillName = 'decision-prototype';
const originalReaddir = fs.promises.readdir.bind(fs.promises);

// Preserve the mature two-interview-Skill contract while adding a third,
// independently tested prototype capability.
fs.promises.readdir = async (target, options) => {
  const entries = await originalReaddir(target, options);
  if (path.basename(String(target)) !== 'skills') return entries;
  return entries.filter((entry) =>
    (typeof entry === 'string' ? entry : entry.name) !== skillName);
};
syncBuiltinESMExports();
await import('./interview-contract.test.mjs');

const read = (file) => readFile(file, 'utf8');
const readJson = async (file) => JSON.parse(await read(file));

async function context() {
  if (!process.env.AW_PLUGIN_CONTEXT) return { source: root, bundle: root, platform: null };
  const value = await readJson(process.env.AW_PLUGIN_CONTEXT);
  assert.equal(value.event, 'test');
  assert.equal(value.plugin.name, 'ask-me');
  return { source: value.sourceRoot, bundle: value.plugin.rootDir, platform: value.platform };
}

const target = await context();

test('manifest and source include decision-prototype', async () => {
  const manifest = await readJson(path.join(target.source, '.agents-plugin', 'plugin.json'));
  assert.equal(manifest.version, '0.2.0');
  assert.match(manifest.description, /原型/);
  assert.equal((await originalReaddir(path.join(target.source, 'skills'))).includes(skillName), true);

  const skillRoot = path.join(target.source, 'skills', skillName);
  const skill = await read(path.join(skillRoot, 'SKILL.md'));
  const metadata = await read(path.join(skillRoot, 'agents', 'openai.yaml'));
  assert.match(skill, /^name: decision-prototype$/m);
  assert.match(skill, /回答一个明确决定/);
  assert.match(skill, /原型默认可丢弃/);
  assert.match(metadata, /display_name: "Decision Prototype"/);
  assert.match(metadata, /\$decision-prototype/);
  assert.match(metadata, /^policy:\n  allow_implicit_invocation: true$/m);
  await read(path.join(skillRoot, 'assets', 'prototype-brief.md'));
});

test('decision-prototype owns trigger and three-way routing evals', async () => {
  const evalRoot = path.join(target.source, 'skills', skillName, 'evals');
  const manifest = await readJson(path.join(evalRoot, 'manifest.json'));
  const trigger = await readJson(path.join(evalRoot, 'trigger-cases.json'));
  const routing = await readJson(path.join(evalRoot, 'ask-me-prototype-routing-cases.json'));
  assert.equal(manifest.plugin, 'ask-me');
  assert.equal(manifest.skill, skillName);
  assert.deepEqual(manifest.suites.map((suite) => suite.id), ['trigger', 'router']);
  assert.deepEqual(manifest.suites[1].skills, [
    'requirements-clarifier', 'decision-grill', 'decision-prototype',
  ]);
  assert.equal(trigger.cases.filter((entry) => entry.should_load_skill).length, 3);
  assert.equal(trigger.cases.filter((entry) => !entry.should_load_skill).length, 3);
  assert.equal(routing.cases.length, 6);
  const allowed = new Set(['requirements-clarifier', 'decision-grill', 'decision-prototype']);
  for (const entry of routing.cases) {
    assert.equal(entry.expected_loaded_skills.every((name) => allowed.has(name)), true);
  }
});

test('prepared bundle renders decision-prototype', async () => {
  if (!target.platform) return;
  const skillRoot = path.join(target.bundle, target.platform, 'skills', skillName);
  const skill = await read(path.join(skillRoot, 'SKILL.md'));
  const expected = target.platform === 'codex' ? '`request_user_input`' : '`AskUserQuestion`';
  const other = target.platform === 'codex' ? '`AskUserQuestion`' : '`request_user_input`';
  assert.equal(skill.includes(expected), true);
  assert.equal(skill.includes(other), false);
  assert.equal(skill.includes('{{questionTool}}'), false);
});
