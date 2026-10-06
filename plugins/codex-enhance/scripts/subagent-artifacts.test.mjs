import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONFIG_KEYS, renderArtifactPlan } from './render-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillIds = ['codex-explore-skill', 'codex-subagent-guide-skill', 'codex-advisor-skill'];
function sourceRoot(id) {
  const staged = path.join(root, '.agents-plugin/artifact-sources/codex', id, '0');
  return existsSync(staged) ? staged : path.join(root, 'skills', id.replace(/-skill$/, ''));
}

function context(values = {}, revision = 'execution-test-revision') {
  return {
    platform: 'codex', scope: 'user', requestedArtifactIds: skillIds,
    artifactSources: skillIds.map((id) => ({ id, target: 'codex.skill', sourceDirs: [sourceRoot(id)] })),
    config: { values }, runtimeConfig: Object.fromEntries(skillIds.map((id) => [id, {
      revision, resourceVersion: 'resource-test-version',
    }])),
  };
}

function skill(plan, id) {
  return plan.artifacts.find((item) => item.id === id).content.files['SKILL.md'];
}

// Test Value Gate: profiles are model data consumed through a public ArtifactPlan;
// metadata enables the actual platform invocation rather than testing prose quality.
test('keeps seven original defaults and initializes independent Advisor defaults', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
  const expected = {
    simpleTaskProfile: ['gpt-6-luna', 'max'], generalTaskProfile: ['gpt-6.1-sol', 'medium'],
    complexTaskProfile: ['gpt-6.1-sol', 'xhigh'], advancedTaskProfile: ['gpt-6-astra', 'high'],
    quickProfile: ['gpt-6-luna', 'medium'], standardProfile: ['gpt-6-luna', 'high'],
    deepProfile: ['gpt-6-luna', 'xhigh'],
  };
  for (const [key, [model, reasoningEffort]] of Object.entries(expected)) {
    assert.deepEqual(manifest.config.fields[key].default, { executor: 'native', model, reasoningEffort });
  }
  const configured = await renderArtifactPlan(context({
    advancedTaskProfile: { executor: 'native', model: 'advanced-specialist', reasoningEffort: 'ultra' },
  }));
  const guide = skill(configured, 'codex-subagent-guide-skill');
  // Static contract exception: the parent method must not grant delegation authority; behavior test is not suitable because the renderer does not execute the parent model's authorization decisions.
  assert.match(guide, /本能力不授予委派权限/);
  const rows = guide.split('\n').filter((line) => /^\| (simple|general|complex|advanced) \|/.test(line));
  assert.equal(rows.length, 4);
  const advanced = rows.find((line) => line.startsWith('| advanced |')).split('|').map((cell) => cell.trim());
  assert.deepEqual(advanced.slice(3).filter(Boolean).map((cell) => JSON.parse(cell.slice(1, -1))),
    ['advancedTaskProfile', 'task', 'native', 'advanced-specialist', 'ultra']);
  const advisor = skill(configured, 'codex-advisor-skill');
  assert.equal(advisor.includes('advanced-specialist'), false);
  assert.equal(advisor.includes('gpt-6-astra'), true);
  assert.equal(guide.includes('subagentCommands'), false);
});

test('preserves model-callable platform metadata for all three parent Skills', async () => {
  const plan = await renderArtifactPlan(context());
  for (const id of skillIds) {
    const key = plan.artifacts.find((item) => item.id === id).skillKey;
    const source = sourceRoot(id);
    const yaml = await readFile(path.join(source, 'agents/openai.yaml'), 'utf8');
    const text = skill(plan, id);
    // Static contract exception: invocation metadata is consumed by Codex to expose these Skills; behavior test is not suitable because the artifact renderer does not execute a Codex host.
    assert.match(yaml, /allow_implicit_invocation:\s*true/);
    assert.match(text, new RegExp(`^name: ${key}$`, 'm'));
    const shortDescription = text.match(/^  short-description: (.+)$/m)?.[1];
    assert.ok(shortDescription);
    assert.match(yaml, new RegExp(`short_description: "${shortDescription}"`));
    assert.ok([...shortDescription].length >= 25 && [...shortDescription].length <= 64);
    assert.doesNotMatch(text, /{{[^}]+}}/);
    assert.equal((await readFile(path.join(source, 'README.md'), 'utf8')).trim().length > 0, true);
  }
});

test('ignores removed wait settings and refreshes each parent from the same ten keys', async () => {
  const defaults = await renderArtifactPlan(context());
  const obsolete = await renderArtifactPlan(context({
    exploreMinimumInitialWaitMinutes: 2, subagentMinimumInitialWaitMinutes: 15,
  }));
  assert.deepEqual(obsolete, defaults);
  for (const artifact of defaults.artifacts) assert.deepEqual(artifact.refreshKeys, CONFIG_KEYS);
});

test('rejects invalid target requests and unsupported platforms', async () => {
  for (const requestedArtifactIds of [[], ['codex-subagent-role', 'codex-subagent-role'], ['unknown']]) {
    await assert.rejects(renderArtifactPlan({ platform: 'codex', requestedArtifactIds }),
      /requestedArtifactIds|Unknown requested artifact/);
  }
  await assert.rejects(renderArtifactPlan({ ...context(), platform: 'claude' }), /Unsupported platform: claude/);
});
