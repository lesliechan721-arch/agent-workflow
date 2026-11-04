import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONFIG_KEYS, SKILL_CONFIG_KEYS, renderArtifactPlan } from './render-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ids = ['codex-explore-skill', 'codex-advisor-skill'];
function context(values = {}) {
  return { platform: 'codex', scope: 'user', requestedArtifactIds: ids, config: { values },
    artifactSources: ids.map((id) => {
      const staged = path.join(root, '.agents-plugin/artifact-sources/codex', id, '0');
      return { id, target: 'codex.skill', sourceDirs: [existsSync(staged) ? staged : path.join(root, 'skills', id.replace(/-skill$/, ''))] };
    }) };
}
function artifact(plan, id) { return plan.artifacts.find((item) => item.id === id); }
function rows(plan, id, prefix = '| 档位 |') {
  const lines = artifact(plan, id).content.files['SKILL.md'].split('\n');
  const start = lines.findIndex((line) => line.startsWith(prefix));
  const result = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    result.push(line.split('|').slice(1, -1).map((cell) => {
      const value = cell.trim(); return value.startsWith('`') ? JSON.parse(value.slice(1, -1)) : value;
    }));
  }
  return result;
}

// Test Value Gate: specialist configuration must retain its defaults and directly reference the provider registry.
test('keeps specialist native requirements and same-source provider references', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, ['agent-subagent']);
  assert.ok(manifest.requires.aw.capabilities.includes('aw.plugin-config-cross-plugin-value-ref.v1'));
  assert.deepEqual(new Set(Object.keys(manifest.config.fields)), new Set(CONFIG_KEYS));
  const profile = manifest.config.definitions?.agentProfile ?? manifest.config.fields.advisorGeneralProfile;
  const executor = manifest.config.definitions?.agentExecutor ?? profile.properties.executor;
  assert.deepEqual(executor.valueRef, { plugin: 'agent-subagent', field: 'subagentCommands', key: 'key', include: ['native'] });
  for (const key of ['model', 'reasoningEffort']) {
    assert.equal(profile.variants.cases.native.properties[key].required, true);
    assert.equal(profile.variants.otherwise.properties[key].required, undefined);
  }
  const expected = {
    quickProfile: ['gpt-6-luna', 'medium'], standardProfile: ['gpt-6-luna', 'high'], deepProfile: ['gpt-6-luna', 'xhigh'],
    advisorGeneralProfile: ['gpt-6-astra', 'high'], advisorAdvancedProfile: ['gpt-6-astra', 'xhigh'], advisorExpertProfile: ['gpt-6-astra', 'max'],
  };
  for (const [key, [model, reasoningEffort]] of Object.entries(expected)) {
    assert.deepEqual(manifest.config.fields[key].default, { executor: 'native', model, reasoningEffort });
  }
  assert.equal(manifest.managedCommands, undefined);
  assert.equal(manifest.nativeTools, undefined);
  assert.deepEqual(manifest.artifacts.targets.map((target) => target.id),
    ['codex-explore-skill', 'codex-explore-role', 'codex-advisor-skill', 'codex-advisor-role']);
});

// Test Value Gate: rendering must preserve optional external settings and custom ordering without exposing provider config.
test('renders only specialist profiles and preserves optional external fields', async () => {
  const defaults = await renderArtifactPlan(context());
  assert.deepEqual(rows(defaults, 'codex-advisor-skill').map((row) => [row[0], ...row.slice(2)]),
    [['general', 'native', 'gpt-6-astra', 'high'], ['advanced', 'native', 'gpt-6-astra', 'xhigh'], ['expert', 'native', 'gpt-6-astra', 'max']]);
  const applicability = '数据库|锁`\n<details>';
  const input = context({ advisorAdvancedProfile: { executor: 'external', reasoningEffort: 'high' },
    exploreCustomProfiles: [{ applicability, executor: 'external' }, { applicability: '第二项', model: 'custom', reasoningEffort: 'max' }] });
  Object.defineProperty(input.config.values, 'subagentCommands', { get() { throw new Error('read provider registry'); } });
  const plan = await renderArtifactPlan(input);
  assert.deepEqual(rows(plan, 'codex-advisor-skill').find((row) => row[0] === 'advanced').slice(2), ['external', '后端默认', 'high']);
  assert.deepEqual(rows(plan, 'codex-explore-skill', '| 适用范围 |'),
    [[applicability, 'external', '后端默认', '后端默认'], ['第二项', 'native', 'custom', 'max']]);
  for (const id of ids) {
    const item = artifact(plan, id);
    assert.deepEqual(item.refreshKeys, SKILL_CONFIG_KEYS[item.skillKey]);
    assert.equal(Object.hasOwn(item.content.files, 'scripts/aw-runtime-config.mjs'), false);
    assert.equal(Object.hasOwn(item.content.files, '.aw-runtime-config.json'), false);
    // Static contract exception: Codex consumes the Skill invocation metadata directly; behavior test is not suitable without a real Codex host.
    assert.match(item.content.files['agents/openai.yaml'], /allow_implicit_invocation:\s*true/);
    assert.equal(item.content.files['SKILL.md'].match(/^name: (.+)$/m)?.[1], item.skillKey);
  }
  for (const advisorAdvancedProfile of [{}, { model: 'incomplete' }, null]) {
    await assert.rejects(renderArtifactPlan(context({ advisorAdvancedProfile })));
  }
});
