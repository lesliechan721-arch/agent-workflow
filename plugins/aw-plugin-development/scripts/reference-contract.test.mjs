import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginContext = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8'))
  : null;
const runtimeRoot = pluginContext?.platform
  ? path.join(pluginRoot, pluginContext.platform)
  : pluginRoot;

test('AW author maps every supported component and core lifecycle branch to a direct reference', async () => {
  // Static contract exception: installed agents must discover each maintained AW author reference from the final Skill entrypoint; behavior test is not suitable because the consumer contract is the final Skill instruction itself.
  const root = path.join(runtimeRoot, 'skills', 'author-aw-plugin');
  const skill = await readFile(path.join(root, 'SKILL.md'), 'utf8');
  const refs = [
    'aw-authoring-profile.md',
    'plugin-manifest-spec.md',
    'aw-validation-and-version.md',
    'aw-skill-integration.md',
    'skill-frontmatter-capabilities.md',
    'extensions-spec.md',
    'slash-commands.md',
    'mcp-and-apps.md',
    'claude-only-capabilities.md',
    'build-config-spec.md',
    'aw-script-testing.md',
    'aw-config-and-helper.md',
    'aw-artifact-renderer.md',
    'aw-lifecycle.md',
    'aw-readme-authoring.md',
  ];
  for (const ref of refs) {
    const content = await readFile(path.join(root, 'references', ref), 'utf8');
    assert.ok(content.length > 150, ref + ' must contain focused guidance');
    assert.match(skill, new RegExp('references/' + ref.replaceAll('.', '\\.'), 'u'));
  }
});

test('AW author does not make Audit, Review, or model Eval part of change completion', async () => {
  // Static contract exception: installed author instructions must not authorize unrequested review or model cost; behavior test is not suitable because the safety boundary is the final Skill instruction itself.
  const skill = await readFile(
    path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'SKILL.md'),
    'utf8',
  );
  const validation = await readFile(
    path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'references', 'aw-validation-and-version.md'),
    'utf8',
  );
  assert.doesNotMatch(skill, /validity=pass|blockedCases|result-triage|run-aw-skill-evals/u);
  assert.match(skill, /完成条件不包括独立 Review 或模型 Eval/u);
  assert.match(validation, /Author 的完成条件不依赖模型 Eval/u);
});

test('AW config reference keeps private values out of presets', async () => {
  // Static contract exception: installed author instructions must retain the no-secret preset rule; behavior test is not suitable because this plugin supplies author guidance and does not execute config writes itself.
  const reference = await readFile(
    path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'references', 'aw-config-and-helper.md'),
    'utf8',
  );
  assert.match(reference, /preset 不得包含 sensitive、`file` 或 `directory` 字段/u);
});
