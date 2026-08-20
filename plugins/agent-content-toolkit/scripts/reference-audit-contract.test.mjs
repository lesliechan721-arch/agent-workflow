import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('content toolkit is the canonical owner of reference audit guidance', async () => {
  const [skill, reference] = await Promise.all([
    readFile(path.join(root, 'skills/review-agent-content/SKILL.md'), 'utf8'),
    readFile(path.join(root, 'skills/review-agent-content/references/reference-audit.md'), 'utf8'),
  ]);
  assert.match(skill, /references\/reference-audit\.md/u);
  assert.match(reference, /Branch locality/u);
  assert.match(reference, /split-by-branch/u);
});
