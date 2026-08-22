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

for (const skillName of ['author-aw-plugin', 'review-aw-plugin']) {
  test(`${skillName} supports automatic and explicit invocation after installation`, async () => {
    const [skill, metadata] = await Promise.all([
      readFile(path.join(runtimeRoot, 'skills', skillName, 'SKILL.md'), 'utf8'),
      readFile(path.join(runtimeRoot, 'skills', skillName, 'agents', 'openai.yaml'), 'utf8'),
    ]);

    assert.match(skill, /^user-invocable:\s*true\s*$/mu);
    assert.doesNotMatch(skill, /^disable-model-invocation:\s*true\s*$/mu);
    assert.match(metadata, /^\s*allow_implicit_invocation:\s*true\s*$/mu);
  });
}
