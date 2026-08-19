import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const localPluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = process.env.AW_PLUGIN_CONTEXT
  ? JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, 'utf8')).sourceRoot
  : localPluginRoot;
const evalRoot = path.join(pluginRoot, 'skills', 'review-agent-skill', 'evals');

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every(
    (entry) => typeof entry === 'string' && entry.trim() !== '',
  );
}

test('review behavior suite is diagnostic, realistic, and non-release-weighted', async () => {
  const [manifest, corpus] = await Promise.all([
    readFile(path.join(evalRoot, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(path.join(evalRoot, 'behavior-cases.json'), 'utf8').then(JSON.parse),
  ]);
  const suite = manifest.suites.find((entry) => entry.id === 'behavior');
  assert.ok(suite, 'manifest must include the behavior suite');
  assert.equal(suite.kind, 'conversation');
  assert.equal(suite.cases, './behavior-cases.json');
  assert.equal(suite.requiredForRelease, false);
  assert.deepEqual(suite.releaseSplits, []);
  assert.equal(suite.isolation, 'strict');
  assert.ok(suite.skills.includes('review-agent-skill'));

  assert.equal(corpus.skill_name, 'review-agent-skill');
  assert.ok(Array.isArray(corpus.evals));
  const expectedIds = new Set([
    'compact_bundle_selective_consumption',
    'reject_stale_stage_handoff',
    'canonical_content_standard_precedence',
    'missing_runtime_evidence_remains_provisional',
  ]);
  const ids = corpus.evals.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(new Set(ids), expectedIds);

  const forbiddenObservedResultFields = new Set([
    'runResult', 'run_result', 'passed', 'outcome', 'trace', 'score', 'observed',
  ]);
  for (const row of corpus.evals) {
    assert.equal(row.sandbox, 'read-only');
    assert.deepEqual(row.scripted_replies, []);
    assert.equal(row.review.workspace_unchanged, true);
    assert.ok(nonEmptyStrings(row.review.checks));
    assert.equal(typeof row.prompt, 'string');
    assert.equal(typeof row.expected_output, 'string');
    assert.ok(row.workspace_files && Object.keys(row.workspace_files).length > 0);
    for (const field of forbiddenObservedResultFields) {
      assert.equal(field in row, false, `${row.id} must not claim an observed run result`);
    }
  }

  const compact = corpus.evals.find((entry) => entry.id === 'compact_bundle_selective_consumption');
  assert.match(compact.prompt, /quick/u);
  assert.match(compact.expected_output, /无关|unrelated/u);
  assert.ok(Object.values(compact.workspace_files).some((content) =>
    content.includes('UNRELATED_EVAL_BODY_MUST_NOT_DRIVE_QUICK_REVIEW')));

  const stale = corpus.evals.find((entry) => entry.id === 'reject_stale_stage_handoff');
  assert.match(stale.prompt, /验证 provided stage handoff/u);
  assert.match(stale.expected_output, /blocked\/unknown|blocked|unknown/u);

  const canonical = corpus.evals.find((entry) => entry.id === 'canonical_content_standard_precedence');
  assert.ok('canonical/content-rules.json' in canonical.workspace_files);
  assert.ok('overlay/skill-rules.json' in canonical.workspace_files);
  assert.ok('legacy/duplicated-rules.json' in canonical.workspace_files);
  assert.match(canonical.workspace_files['generate-standard-views.mjs'], /canonical\/content-rules\.json/u);
  assert.doesNotMatch(canonical.workspace_files['generate-standard-views.mjs'], /load-standard-source/u);

  const provisional = corpus.evals.find((entry) => entry.id === 'missing_runtime_evidence_remains_provisional');
  assert.match(provisional.prompt, /没有真实模型运行/u);
  assert.match(provisional.expected_output, /provisional|unknown/u);
});
