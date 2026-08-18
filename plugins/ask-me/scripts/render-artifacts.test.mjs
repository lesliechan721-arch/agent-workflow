import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAUDE_QUALITY_GATE_ARTIFACT_ID,
  CODEX_QUALITY_GATE_ARTIFACT_ID,
  QUALITY_GATE_CONFIG_KEY,
  renderArtifactPlan,
} from './render-artifacts.mjs';

function context(platform, enabled, issues = []) {
  return {
    platform,
    config: {
      values: { [QUALITY_GATE_CONFIG_KEY]: enabled },
      issues,
    },
  };
}

test('renders the Codex quality gate when enabled', () => {
  const plan = renderArtifactPlan(context('codex', true));
  assert.equal(plan.version, 2);
  assert.equal(plan.artifacts.length, 1);
  const [artifact] = plan.artifacts;
  assert.equal(artifact.id, CODEX_QUALITY_GATE_ARTIFACT_ID);
  assert.equal(artifact.target, 'codex.developerInstructionsBlock');
  assert.equal(artifact.state, 'present');
  assert.deepEqual(artifact.refreshKeys, [QUALITY_GATE_CONFIG_KEY]);
  assert.match(artifact.content, /requirements-clarifier/);
  assert.doesNotMatch(artifact.content, /decision-grill/);
});

test('renders an internal Claude quality-gate Skill when enabled', () => {
  const plan = renderArtifactPlan(context('claude', true));
  const [artifact] = plan.artifacts;
  assert.equal(artifact.id, CLAUDE_QUALITY_GATE_ARTIFACT_ID);
  assert.equal(artifact.target, 'claude.skill');
  assert.equal(artifact.state, 'present');
  assert.equal(artifact.skillKey, 'ask-me-quality-gate');
  assert.match(artifact.content.files['SKILL.md'], /^name: ask-me-quality-gate$/m);
  assert.match(artifact.content.files['SKILL.md'], /requirements-clarifier/);
});

test('disables the quality-gate artifact without leaving content', () => {
  for (const platform of ['codex', 'claude']) {
    const plan = renderArtifactPlan(context(platform, false));
    const [artifact] = plan.artifacts;
    assert.equal(artifact.state, 'disabled');
    assert.equal(artifact.disabledReason, 'config');
    assert.equal('content' in artifact, false);
    assert.deepEqual(artifact.refreshKeys, [QUALITY_GATE_CONFIG_KEY]);
  }
});

test('fails closed for invalid or missing config', () => {
  assert.throws(
    () => renderArtifactPlan({ platform: 'codex', config: { values: {}, issues: [] } }),
    /must be boolean/,
  );
  assert.throws(
    () => renderArtifactPlan(context('codex', true, [{ key: QUALITY_GATE_CONFIG_KEY }])),
    /invalid config/,
  );
});
