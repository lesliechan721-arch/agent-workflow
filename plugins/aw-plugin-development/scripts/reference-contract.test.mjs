import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('AW author guidance discloses config, renderer, lifecycle, and testing by branch', async () => {
  const root = path.join(pluginRoot, 'skills', 'author-aw-plugin');
  const skill = await readFile(path.join(root, 'SKILL.md'), 'utf8');
  const references = [
    'aw-config-and-helper.md',
    'aw-artifact-renderer.md',
    'aw-lifecycle.md',
    'aw-script-testing.md',
  ];

  for (const reference of references) {
    const content = await readFile(path.join(root, 'references', reference), 'utf8');
    assert.ok(content.length > 200, `${reference} must contain focused guidance`);
    assert.match(skill, new RegExp(`references/${reference.replace('.', '\\.')}`, 'u'));
  }

  await assert.rejects(
    readFile(path.join(root, 'references', 'aw-scripts-config-lifecycle.md'), 'utf8'),
  );
});
