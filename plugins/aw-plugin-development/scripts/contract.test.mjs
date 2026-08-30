import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const skillValidatorBin = path.resolve(sourceRoot, '..', '..', 'packages', 'cli', 'dist', 'index.js');
const temps = [];
after(async () => Promise.all(temps.map((entry) => rm(entry, { recursive: true, force: true }))));
const reviewSkillRoot = path.join(runtimeRoot, 'skills/review-aw-plugin');
const materializedRuntime = { skip: context ? false : 'requires plugin:test materialization' };
const testBinRoot = await mkdtemp(path.join(tmpdir(), 'aw-review-contract-bin-'));
temps.push(testBinRoot);
await writeFile(path.join(testBinRoot, 'aw'), `#!/bin/sh
if [ "$1" = "plugin" ]; then
  printf '%s\\n' '{"ok":true,"errors":[]}'
  exit 0
fi
exec "${process.execPath}" "${skillValidatorBin}" "$@"
`);
await chmod(path.join(testBinRoot, 'aw'), 0o755);
async function runJson(file, args = []) {
  try {
    return JSON.parse((await execFileAsync(process.execPath, [file, ...args], {
      cwd: runtimeRoot,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${testBinRoot}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    })).stdout);
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout);
    throw error;
  }
}

test('non-Publisher Skills preserve an explicit Workspace target across context and commands', async () => {
  const skills = await Promise.all([
    'author-aw-plugin',
    'review-aw-plugin',
    'review-aw-workflow',
  ].map((name) => readFile(path.join(runtimeRoot, 'skills', name, 'SKILL.md'), 'utf8')));

  // Static contract exception: a target outside cwd must reach the first context command and all later public commands unchanged; behavior execution is covered by the explicit-target Eval fixture because this package test only receives final instruction text.
  for (const skill of skills) {
    assert.match(skill, /aw catalog context \[--workspace-root <target-root>\] --json/u);
    assert.match(skill, /用户明确的 Workspace root.*canonical.*上游 handoff.*current Workspace/su);
    assert.match(skill, /receipt 的 `workspace\.root` 必须与所选 target 一致/u);
    assert.match(skill, /canonical targets? 或 handoff paths? 时?与其一致|所有 canonical targets 或 handoff paths 一致/u);
    assert.match(skill, /不一致时停止/u);
    assert.match(skill, /只在 root 缺失或歧义时询问/u);
    assert.match(
      skill,
      /--workspace-root <workspace-root>|--plugin <workspace-root>\/plugins/u,
    );
  }
});

test('review adapter manifest and runtime contain only current quality and release tools', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'));
  const targets = manifest.buildConfig.skillRuntimeFiles
    .filter((entry) => entry.skill === 'review-aw-plugin')
    .map((entry) => entry.target)
    .sort();
  assert.deepEqual(targets, [
    'assets/quality-review-result.schema.json',
    'assets/review-dimensions.json',
    'references/review-publication.md',
    'scripts/check-agent-skill.mjs',
    'scripts/check-aw-plugin-release.mjs',
    'scripts/review-skill-leaf-plan.mjs',
    'scripts/validate-quality-review-result.mjs',
  ]);
  assert.ok((await readFile(path.join(reviewSkillRoot, 'scripts/discover-aw-review-targets.mjs'), 'utf8')).length > 100);
});

test('AW reviewer production and materialized closures use registered current dependencies', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, '.agents-plugin/plugin.json'), 'utf8'));
  assert.deepEqual(manifest.buildConfig.runtimeExports ?? [], []);
  assert.deepEqual(manifest.buildConfig.buildImports ?? [], []);
  assert.deepEqual(manifest.buildConfig.generatedSkillRuntimeFiles ?? [], []);
  assert.equal(manifest.scripts.node?.build, undefined);
  assert.ok(!manifest.requires.aw.capabilities.includes('aw.review-publication.v1'));
  assert.deepEqual(
    manifest.buildConfig.skillRuntimeFiles
      .flatMap((entry) => entry.import ? [`${entry.import.plugin}:${entry.import.export}`] : [])
      .sort(),
    [
      'agent-skill-toolkit:check-agent-skill',
      'agent-skill-toolkit:quality-review-result-schema',
      'agent-skill-toolkit:review-dimensions',
      'agent-skill-toolkit:review-publication-reference',
      'agent-skill-toolkit:review-publication-reference',
      'agent-skill-toolkit:skill-design-brief-schema',
      'agent-skill-toolkit:validate-json-contract',
      'agent-skill-toolkit:validate-quality-review-result',
    ],
  );
});

test('target discovery groups identical content by digest and preserves real differences', materializedRuntime, async () => {
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
    await mkdir(path.join(root, 'agents'), { recursive: true });
    await writeFile(path.join(root, 'SKILL.md'), skillText);
    await writeFile(path.join(root, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
  }
  const discover = path.join(reviewSkillRoot, 'scripts/discover-aw-review-targets.mjs');
  const first = await runJson(discover, [plugin, '--workspace-root', temp, '--final', `codex-project=${path.dirname(codexSkill)}`, '--final', `claude-project=${path.dirname(claudeSkill)}`, '--format', 'json']);
  assert.equal(first.targets.length, 3);
  assert.equal(first.uniqueReviews.length, 1);
  assert.equal(first.uniqueReviews[0].targetIds.length, 3);

  await writeFile(path.join(claudeSkill, 'SKILL.md'), skillText.replace('one approved notice', 'approved single or batch notices'));
  const second = await runJson(discover, [plugin, '--workspace-root', temp, '--final', `codex-project=${path.dirname(codexSkill)}`, '--final', `claude-project=${path.dirname(claudeSkill)}`, '--format', 'json']);
  assert.equal(second.uniqueReviews.length, 2);
});

test('target discovery requires real materialized content for build-generated Skill resources', materializedRuntime, async () => {
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
  await mkdir(path.join(finalSkill, 'agents'), { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({
    name: 'generated-plugin',
    version: '1.0.0',
    skills: './skills',
    scripts: { node: { build: { runner: 'node', path: './scripts/build.mjs', args: [] } } },
  }));
  await writeFile(path.join(sourceSkill, 'SKILL.md'), skillText);
  await writeFile(path.join(finalSkill, 'SKILL.md'), skillText);
  await writeFile(path.join(finalSkill, 'references', 'generated.md'), '# Generated\n\nRuntime content.\n');
  await writeFile(path.join(finalSkill, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
  const discover = path.join(reviewSkillRoot, 'scripts/discover-aw-review-targets.mjs');
  await assert.rejects(runJson(discover, [plugin, '--workspace-root', temp, '--format', 'json']), /materialized --final collection/u);
  const result = await runJson(discover, [plugin, '--workspace-root', temp, '--final', `codex-project=${finalRoot}`, '--format', 'json']);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].kind, 'materialized-skill');
  assert.equal(result.targets[0].machineCheck.ok, true);
  assert.equal(result.uniqueReviews.length, 1);
});

test('target discovery surfaces machine errors without review workflow state', materializedRuntime, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'aw-light-review-error-'));
  temps.push(temp);
  const plugin = path.join(temp, 'plugin');
  const skill = path.join(plugin, 'skills', 'broken');
  await mkdir(path.join(plugin, '.agents-plugin'), { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(plugin, '.agents-plugin', 'plugin.json'), JSON.stringify({ name: 'broken-plugin', version: '1.0.0', skills: './skills' }));
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: broken\ndescription: Broken fixture.\n---\n\nRun `node scripts/missing.mjs`.\n');
  const discover = path.join(reviewSkillRoot, 'scripts/discover-aw-review-targets.mjs');
  const result = await runJson(discover, [plugin, '--workspace-root', temp, '--format', 'json']);
  assert.equal(result.targets[0].machineCheck.ok, false);
  assert.ok(result.targets[0].machineCheck.errors.some((entry) => entry.code === 'missing-runtime-resource'));
  assert.equal('providedStages' in result, false);
  assert.equal('profileCoverage' in result, false);
});
