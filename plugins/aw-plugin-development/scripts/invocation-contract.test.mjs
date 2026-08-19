import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const skillName of ['author-aw-plugin', 'review-aw-plugin']) {
  test(`${skillName} supports automatic and explicit invocation after installation`, async () => {
    const [skill, metadata] = await Promise.all([
      readFile(path.join(pluginRoot, 'skills', skillName, 'SKILL.md'), 'utf8'),
      readFile(path.join(pluginRoot, 'skills', skillName, 'agents', 'openai.yaml'), 'utf8'),
    ]);

    assert.match(skill, /^user-invocable:\s*true\s*$/mu);
    assert.doesNotMatch(skill, /^disable-model-invocation:\s*true\s*$/mu);
    assert.doesNotMatch(skill, /仅当用户显式要求/u);
    assert.match(metadata, /^\s*allow_implicit_invocation:\s*true\s*$/mu);
  });
}
