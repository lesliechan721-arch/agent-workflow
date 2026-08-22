import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const execFileAsync = promisify(execFile);
const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const sourceRoot = context?.sourceRoot ?? localRoot;
const runtimeRoot = context?.platform ? path.join(localRoot, context.platform) : localRoot;
const temps = [];
after(async () => Promise.all(temps.map((entry) => rm(entry, { recursive: true, force: true }))));

async function runJson(file, args = []) {
  try {
    return JSON.parse((await execFileAsync(process.execPath, [file, ...args], {
      cwd: runtimeRoot,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    })).stdout);
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout);
    throw error;
  }
}

test('review adapter runtime contains only lightweight review and release tools', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'));
  const targets = manifest.buildConfig.skillRuntimeFiles
    .filter((entry) => entry.skill === 'review-aw-plugin')
    .map((entry) => entry.target)
    .sort();
  assert.deepEqual(targets, [
    'assets/review-result-lite.schema.json',
    'scripts/check-agent-skill.mjs',
    'scripts/check-aw-plugin-release.mjs',
    'scripts/validate-review-result-lite.mjs',
  ]);
  const skillRoot = path.join(runtimeRoot, 'skills/review-aw-plugin');
  for (const relative of [
    'assets/aw-review-summary.json',
    'assets/review-input-bundle.json',
    'assets/aw-review-summary.schema.json',
    'assets/aw-review-target-plan.schema.json',
    'assets/review-input-bundle.schema.json',
    'assets/review-result.schema.json',
    'scripts/inspect-aw-target.mjs',
    'scripts/prepare-aw-review-bundle.mjs',
    'scripts/prepare-aw-review-target-plan.mjs',
    'scripts/prepare-aw-review-targets.mjs',
    'scripts/review-artifact-policy.mjs',
    'scripts/validate-aw-review-summary.mjs',
    'scripts/validate-review-input-bundle.mjs',
    'scripts/validate-review-result.mjs',
  ]) {
    await assert.rejects(readFile(path.join(skillRoot, relative), 'utf8'), relative);
  }
  assert.ok((await readFile(path.join(skillRoot, 'scripts/discover-aw-review-targets.mjs'), 'utf8')).length > 100);
});

test('author adapter still delegates deterministic work to stable AW CLI commands', async () => {
  const skill = await readFile(path.join(runtimeRoot, 'skills/author-aw-plugin/SKILL.md'), 'utf8');
  // Static contract exception: installed agents must discover every public authoring command and must not execute an undeclared fallback; behavior test is not suitable because the consumer contract is the final Skill instruction itself.
  for (const command of ['init', 'add-skill', 'validate', 'status']) {
    assert.match(skill, new RegExp(`aw plugin ${command} --help`, 'u'));
    assert.match(skill, new RegExp(`aw plugin ${command}(?: <| --)`, 'u'));
  }
  assert.match(skill, /不得回退到本 Skill 的本地工具副本/u);
});

test('target discovery groups identical content by digest and preserves real differences', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-light-review-'));
  temps.push(temp);
  const plugin = path.join(temp, 'plugin');
  const sourceSkill = path.join(plugin, 'skills', 'notify');
  const codexSkill = path.join(temp, 'codex', 'notify');
  const claudeSkill = path.join(temp, 'claude', 'notify');
  const skillText = '---\nname: notify\ndescription: Send one approved notice.\n---\n\n# Notify\n\nSend one approved notice.\n';
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({ name: 'notify-plugin', version: '1.0.0', skills: './skills' }));
  for (const root of [sourceSkill, codexSkill, claudeSkill]) {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'SKILL.md'), skillText);
  }
  const discover = path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/discover-aw-review-targets.mjs');
  const first = await runJson(discover, [plugin, '--final', `codex-project=${path.dirname(codexSkill)}`, '--final', `claude-project=${path.dirname(claudeSkill)}`, '--format', 'json']);
  assert.equal(first.targets.length, 3);
  assert.equal(first.uniqueReviews.length, 1);
  assert.equal(first.uniqueReviews[0].targetIds.length, 3);

  await writeFile(path.join(claudeSkill, 'SKILL.md'), skillText.replace('one approved notice', 'approved single or batch notices'));
  const second = await runJson(discover, [plugin, '--final', `codex-project=${path.dirname(codexSkill)}`, '--final', `claude-project=${path.dirname(claudeSkill)}`, '--format', 'json']);
  assert.equal(second.uniqueReviews.length, 2);
});

test('target discovery requires real materialized content for build-generated Skill resources', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-built-review-'));
  temps.push(temp);
  const plugin = path.join(temp, 'plugin');
  const sourceSkill = path.join(plugin, 'skills', 'generated');
  const finalRoot = path.join(temp, 'final');
  const finalSkill = path.join(finalRoot, 'generated');
  const skillText = '---\nname: generated\ndescription: Read one generated reference.\n---\n\nRead [the generated guide](references/generated.md).\n';
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(sourceSkill, { recursive: true });
  await mkdir(path.join(finalSkill, 'references'), { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'generated-plugin',
    version: '1.0.0',
    skills: './skills',
    scripts: { node: { build: { runner: 'node', path: './scripts/build.mjs', args: [] } } },
  }));
  await writeFile(path.join(sourceSkill, 'SKILL.md'), skillText);
  await writeFile(path.join(finalSkill, 'SKILL.md'), skillText);
  await writeFile(path.join(finalSkill, 'references', 'generated.md'), '# Generated\n\nRuntime content.\n');
  const discover = path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/discover-aw-review-targets.mjs');
  await assert.rejects(runJson(discover, [plugin, '--format', 'json']), /materialized --final collection/u);
  const result = await runJson(discover, [plugin, '--final', `codex-project=${finalRoot}`, '--format', 'json']);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].kind, 'materialized-skill');
  assert.equal(result.targets[0].machineCheck.ok, true);
  assert.equal(result.uniqueReviews.length, 1);
});

test('target discovery surfaces machine errors without review workflow state', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-light-review-error-'));
  temps.push(temp);
  const plugin = path.join(temp, 'plugin');
  const skill = path.join(plugin, 'skills', 'broken');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({ name: 'broken-plugin', version: '1.0.0', skills: './skills' }));
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: broken\ndescription: Broken fixture.\n---\n\nRun `node scripts/missing.mjs`.\n');
  const discover = path.join(runtimeRoot, 'skills/review-aw-plugin/scripts/discover-aw-review-targets.mjs');
  const result = await runJson(discover, [plugin, '--format', 'json']);
  assert.equal(result.targets[0].machineCheck.ok, false);
  assert.ok(result.targets[0].machineCheck.errors.some((entry) => entry.code === 'missing-runtime-resource'));
  assert.equal('providedStages' in result, false);
  assert.equal('profileCoverage' in result, false);
});
