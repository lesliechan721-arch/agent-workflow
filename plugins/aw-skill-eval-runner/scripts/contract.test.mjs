import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.env.AW_PLUGIN_ROOT;

test('publishes one model-callable Skill with the Eval capability', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, '.agents-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'aw-skill-eval-runner');
  assert.ok(manifest.requires.aw.capabilities.includes('aw.skill-eval.v2'));
  assert.deepEqual(readdirSync(path.join(root, 'codex', 'skills')).sort(), ['run-aw-skill-evals']);

  const skillRoot = path.join(root, 'codex', 'skills', 'run-aw-skill-evals');
  const policyLines = readFileSync(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('allow_implicit_invocation:'));
  assert.deepEqual(policyLines, ['allow_implicit_invocation: true']);

  const result = spawnSync('aw', [
    'skill', 'validate', skillRoot,
    '--frontmatter-profile', 'portable-agent-skills',
    '--codex-metadata', 'required',
    '--json',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).ok, true);
});
