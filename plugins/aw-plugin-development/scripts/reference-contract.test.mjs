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
test('AW author maps every supported component to a direct reference', async () => {
  const root = path.join(runtimeRoot, 'skills', 'author-aw-plugin');
  const skill = await readFile(path.join(root, 'SKILL.md'), 'utf8');
  const refs = [
    'plugin-manifest-spec.md',
    'aw-skill-integration.md',
    'skill-frontmatter-capabilities.generated.md',
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
    assert.ok(content.length > 200, ref + ' must contain focused guidance');
    assert.match(skill, new RegExp('references/' + ref.replaceAll('.', '\\.'), 'u'));
  }
  await assert.rejects(
    readFile(path.join(root, 'references', 'aw-scripts-config-lifecycle.md'), 'utf8'),
  );
});

test('AW config reference keeps private values out of presets', async () => {
  const reference = await readFile(
    path.join(runtimeRoot, 'skills', 'author-aw-plugin', 'references', 'aw-config-and-helper.md'),
    'utf8',
  );
  // Static contract exception: published AW Author guidance must not let users place private values in presets; behavior test is not suitable because this Markdown file is the installed Skill reference consumed by the model.
  assert.match(reference, /preset 不得包含 sensitive、`file` 或 `directory` 字段/u);
});
