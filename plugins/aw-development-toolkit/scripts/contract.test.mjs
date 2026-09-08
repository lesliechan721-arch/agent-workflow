import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.env.AW_PLUGIN_ROOT;
const invocation = new Map([
  ['develop-aw', true],
  ['review-aw', true],
  ['publish-aw-catalog', false],
]);

function runtimeSkill(platform, name) {
  return path.join(root, platform, 'skills', name);
}

test('publishes two model-callable Skills and one manual-only Publisher', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, '.agents-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'aw-development-toolkit');
  assert.ok(manifest.requires.aw.capabilities.includes('aw.review-inspection.v1'));
  assert.ok(manifest.requires.aw.capabilities.includes('aw.review-publication.v1'));
  assert.deepEqual(readdirSync(path.join(root, 'codex', 'skills')).sort(), [...invocation.keys()].sort());

  for (const [skill, expected] of invocation) {
    const skillRoot = runtimeSkill('codex', skill);
    const policyLines = readFileSync(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('allow_implicit_invocation:'));
    assert.deepEqual(policyLines, [`allow_implicit_invocation: ${expected}`], skill);

    const result = spawnSync('aw', [
      'skill', 'validate', skillRoot,
      '--frontmatter-profile', 'claude-current',
      '--codex-metadata', 'required',
      '--json',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
});

test('materializes the AW Review runtime closure on both platforms', () => {
  for (const platform of ['codex', 'claude']) {
    const reviewRoot = runtimeSkill(platform, 'review-aw');
    assert.equal(statSync(path.join(reviewRoot, 'references', 'report-publication.md')).isFile(), true);
    assert.equal(statSync(path.join(reviewRoot, 'scripts', 'check-aw-release.mjs')).isFile(), true);
  }
});
