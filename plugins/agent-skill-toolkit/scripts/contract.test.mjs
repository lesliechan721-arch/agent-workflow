import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.env.AW_PLUGIN_ROOT;
const skills = [
  'author-agent-skill',
  'review-agent-skill',
  'simplify-agent-skill',
  'audit-agent-skill-evals',
  'review-agent-architecture',
];

function runtimeSkill(platform, name) {
  return path.join(root, platform, 'skills', name);
}

test('publishes five model-callable Skills with valid public metadata', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, '.agents-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'agent-skill-toolkit');
  assert.ok(manifest.requires.aw.capabilities.includes('aw.review-publication.v1'));
  assert.deepEqual(readdirSync(path.join(root, 'codex', 'skills')).sort(), [...skills].sort());

  for (const skill of skills) {
    const skillRoot = runtimeSkill('codex', skill);
    const policyLines = readFileSync(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('allow_implicit_invocation:'));
    assert.deepEqual(policyLines, ['allow_implicit_invocation: true'], skill);

    const result = spawnSync('aw', [
      'skill', 'validate', skillRoot,
      '--frontmatter-profile', 'portable-agent-skills',
      '--codex-metadata', 'required',
      '--json',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
});

test('materializes the shared Reviewer resource closure on both platforms', () => {
  const targets = [
    ['author-agent-skill', 'references/invocation-and-description.md'],
    ['author-agent-skill', 'references/composition-audit.md'],
    ['review-agent-skill', 'references/skill-invocation.md'],
    ['review-agent-skill', 'references/skill-composition.md'],
    ['review-agent-skill', 'references/report-publication.md'],
    ['review-agent-skill', 'scripts/audit-output-contracts.mjs'],
    ['review-agent-architecture', 'references/skill-invocation.md'],
    ['review-agent-architecture', 'references/skill-composition.md'],
    ['review-agent-architecture', 'references/report-publication.md'],
    ['review-agent-architecture', 'scripts/audit-output-contracts.mjs'],
  ];
  for (const platform of ['codex', 'claude']) {
    for (const [skill, relative] of targets) {
      assert.equal(statSync(path.join(runtimeSkill(platform, skill), relative)).isFile(), true);
    }
  }
});
