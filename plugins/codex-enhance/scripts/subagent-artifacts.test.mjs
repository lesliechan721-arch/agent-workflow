import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONFIG_KEYS, SKILL_CONFIG_KEYS, renderArtifactPlan } from './render-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const skillIds = ['codex-explore-skill', 'codex-subagent-guide-skill', 'codex-advisor-skill'];
const ids = ['codex-explore-skill', 'codex-explore-role', 'codex-subagent-guide-skill',
  'codex-subagent-role', 'codex-advisor-skill', 'codex-advisor-role'];
function sourceRoot(id) {
  const staged = path.join(root, '.agents-plugin/artifact-sources/codex', id, '0');
  return existsSync(staged) ? staged : path.join(root, 'skills', id.replace(/-skill$/, ''));
}

function context(values = {}) {
  return {
    platform: 'codex', scope: 'user', requestedArtifactIds: skillIds,
    artifactSources: skillIds.map((id) => ({ id, target: 'codex.skill', sourceDirs: [sourceRoot(id)] })),
    config: { values },
  };
}

function skill(plan, id) {
  return plan.artifacts.find((item) => item.id === id).content.files['SKILL.md'];
}

function profiles(text) {
  return Object.fromEntries(text.split('\n').filter((line) => /^\| (simple|general|complex|advanced|quick|standard|deep|design|debug|review) \|/.test(line))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      return [cells[1], Object.fromEntries(['profile', 'executor', 'model', 'reasoningEffort']
        .map((key, i) => [key, JSON.parse(cells[i + 3].slice(1, -1))]))];
    }));
}

function externalRows(plan) {
  const text = plan.artifacts.find((item) => item.id === 'codex-subagent-guide-skill')
    .content.files['references/external-delegation.md'];
  assert.equal(typeof text, 'string');
  return text.split('\n').filter((line) => /^\| `/.test(line)).map((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    // Other tables describe CLI options and terminal states, not executor data.
    if (cells.length !== 6) return undefined;
    return cells.map((cell) => JSON.parse(cell.slice(1, -1)));
  }).filter(Boolean);
}

// Test Value Gate: manifest JSON is the public configuration and delivery contract.
test('shares one profile definition, preserves defaults and declares exact consumer inputs', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.config.schemaVersion, 3);
  assert.deepEqual(new Set(Object.keys(manifest.config.fields)), new Set(CONFIG_KEYS));
  const profile = manifest.config.definitions?.agentProfile ?? manifest.config.fields.advisorProfile;
  if (manifest.config.definitions) assert.deepEqual(Object.keys(manifest.config.definitions), ['agentProfile']);
  assert.equal(profile.additionalProperties, false);
  assert.deepEqual(Object.keys(profile.properties), ['executor', 'model', 'reasoningEffort']);
  assert.deepEqual(profile.properties.executor.valueRef, {
    field: 'subagentCommands', key: 'key', label: 'title', include: ['native'],
  });
  assert.notEqual(profile.properties.executor.required, true);
  assert.equal(profile.properties.model.required, true);
  assert.equal(profile.properties.reasoningEffort.required, true);
  for (const property of Object.values(profile.properties)) assert.equal(property.validation.minLength, 1);
  const defaults = {
    simpleTaskProfile: ['gpt-6-luna', 'max'], generalTaskProfile: ['gpt-6.1-sol', 'medium'],
    complexTaskProfile: ['gpt-6.1-sol', 'xhigh'], advancedTaskProfile: ['gpt-6-astra', 'high'],
    quickProfile: ['gpt-6-luna', 'medium'], standardProfile: ['gpt-6-luna', 'high'],
    deepProfile: ['gpt-6-luna', 'xhigh'], advisorProfile: ['gpt-6-astra', 'high'],
  };
  for (const key of CONFIG_KEYS.filter((key) => key.endsWith('Profile'))) {
    const field = manifest.config.fields[key];
    if (manifest.config.definitions) {
      assert.equal(field.$ref, '#/config/definitions/agentProfile');
    } else {
      assert.equal(field.type, 'object');
      assert.equal(field.additionalProperties, false);
      assert.deepEqual(field.properties, profile.properties);
    }
    if (Object.hasOwn(defaults, key)) {
      const [model, reasoningEffort] = defaults[key];
      assert.deepEqual(field.default, { executor: 'native', model, reasoningEffort });
      assert.equal(field.required, true);
    } else {
      assert.equal(Object.hasOwn(field, 'default'), false);
      assert.equal(Object.hasOwn(field, 'required'), false);
    }
  }
  assert.deepEqual(manifest.config.presentation.groups.find((group) => group.id === 'codex-advisor').fields,
    ['advisorProfile', 'advisorDesignProfile', 'advisorDebugProfile', 'advisorReviewProfile']);
  assert.deepEqual(manifest.config.fields.subagentCommands.default, []);
  assert.equal(manifest.config.fields.subagentCommands.validation.uniqueBy, 'key');
  assert.deepEqual(manifest.marketplace.policy.products, ['CODEX']);
  assert.ok(manifest.requires.aw.capabilities.includes('aw.installed-runtime-config.v2'));
  assert.equal(manifest.requires.aw.capabilities.includes('aw.installed-runtime-config.v1'), false);
  assert.deepEqual(manifest.artifacts.targets.map((item) => item.id), ids);
  for (const target of manifest.artifacts.targets) {
    assert.deepEqual(target.scopes, ['user', 'project']);
    if (target.target === 'codex.skill') {
      assert.deepEqual(target.delivery, { mode: 'codex-native', identity: 'shared', renderProfile: 'user' });
      assert.deepEqual(target.refreshKeys, SKILL_CONFIG_KEYS[target.skillKey]);
      assert.deepEqual(target.runtimeConfig, target.skillKey === 'codex-subagent-guide' ? { keys: CONFIG_KEYS } : undefined);
    } else {
      assert.deepEqual(target.refreshKeys, []);
      assert.equal(target.runtimeConfig, undefined);
    }
  }
});

// Test Value Gate: tables contain profile data actually delivered to the parent model.
test('renders four task profiles, three exploration profiles and only configured consultations', async () => {
  const defaults = await renderArtifactPlan(context());
  assert.equal(Object.keys(profiles(skill(defaults, 'codex-subagent-guide-skill'))).length, 4);
  assert.equal(Object.keys(profiles(skill(defaults, 'codex-explore-skill'))).length, 3);
  assert.deepEqual(profiles(skill(defaults, 'codex-advisor-skill')), {
    general: { profile: 'advisorProfile', executor: 'native', model: 'gpt-6-astra', reasoningEffort: 'high' },
  });
  const values = {
    advancedTaskProfile: { model: 'advanced-specialist', reasoningEffort: 'ultra' },
    advisorProfile: { model: 'general-consultant', reasoningEffort: 'medium' },
    advisorDebugProfile: { executor: 'external-debug', model: 'debug-specialist', reasoningEffort: 'max' },
    subagentCommands: [{ key: 'external-debug', title: 'Debug', mode: 'workspace', command: '/adapter' }],
  };
  const configured = await renderArtifactPlan(context(values));
  assert.deepEqual(profiles(skill(configured, 'codex-subagent-guide-skill')).advanced,
    { profile: 'advancedTaskProfile', executor: 'native', model: 'advanced-specialist', reasoningEffort: 'ultra' });
  assert.deepEqual(profiles(skill(configured, 'codex-advisor-skill')), {
    general: { profile: 'advisorProfile', executor: 'native', model: 'general-consultant', reasoningEffort: 'medium' },
    debug: { profile: 'advisorDebugProfile', executor: 'external-debug', model: 'debug-specialist', reasoningEffort: 'max' },
  });
  assert.equal(Object.hasOwn(values.advancedTaskProfile, 'executor'), false);
  const independent = await renderArtifactPlan(context({ advancedTaskProfile: values.advancedTaskProfile }));
  assert.deepEqual(profiles(skill(independent, 'codex-advisor-skill')), profiles(skill(defaults, 'codex-advisor-skill')));
});

// Test Value Gate: the installed configuration projection must not advertise absent
// profile keys outside its table. Inspect rendered data, not fixed prose or source text.
test('advertises only configured advisor profile keys throughout the rendered Skill', async () => {
  const optionalKeys = ['advisorDesignProfile', 'advisorDebugProfile', 'advisorReviewProfile'];
  for (let mask = 0; mask < 1 << optionalKeys.length; mask++) {
    const configuredKeys = optionalKeys.filter((_key, index) => mask & (1 << index));
    const values = Object.fromEntries(configuredKeys.map((key) => [key, {
      model: `specialist-${key}`, reasoningEffort: 'high',
    }]));
    const plan = await renderArtifactPlan({ ...context(values), requestedArtifactIds: ['codex-advisor-skill'] });
    const text = skill(plan, 'codex-advisor-skill');
    const advertisedKeys = new Set([...text.matchAll(/\badvisor(?:Design|Debug|Review)?Profile\b/g)]
      .map(([key]) => key));
    assert.deepEqual(advertisedKeys, new Set(['advisorProfile', ...configuredKeys]));
  }
});

// Test Value Gate: the external caller needs the actual mode and declared capabilities
// without a preview process. The public renderer must preserve every configured key.
test('renders executor modes and capabilities only in the Guide external reference', async () => {
  const subagentCommands = [
    { key: 'service-A', title: '材料服务', mode: 'bundle', command: '/not-invoked/adapter',
      supportsSystemInstructions: true, supportsReadOnly: true, supportsWorkspaceWrite: true },
    { key: 'service-a', title: '工程服务', mode: 'workspace', command: '/not-invoked/adapter',
      supportsSystemInstructions: true, supportsReadOnly: true, supportsWorkspaceWrite: true },
    { key: 'limited', title: '未声明能力', mode: 'workspace', command: '/not-invoked/adapter' },
  ];
  const expected = [
    ['service-A', '材料服务', 'bundle', true, true, false],
    ['service-a', '工程服务', 'workspace', true, true, true],
    ['limited', '未声明能力', 'workspace', false, false, false],
  ];
  for (const scope of ['user', 'project']) {
    const baseline = await renderArtifactPlan({ ...context(), scope, requestedArtifactIds: ids });
    const plan = await renderArtifactPlan({ ...context({ subagentCommands }), scope, requestedArtifactIds: ids });
    assert.deepEqual(plan.artifacts.map((item) => item.id), ids);
    assert.deepEqual(externalRows(plan), expected);
    assert.equal(skill(plan, 'codex-subagent-guide-skill'), skill(baseline, 'codex-subagent-guide-skill'));
    for (const id of ids.filter((id) => id !== 'codex-subagent-guide-skill')) {
      assert.deepEqual(plan.artifacts.find((item) => item.id === id), baseline.artifacts.find((item) => item.id === id));
    }
  }
});

// Test Value Gate: refreshed references must not retain removed commands or obsolete modes.
test('refreshes executor data from each render request and handles an empty registry', async () => {
  const initial = { key: 'service', title: '已配置服务', mode: 'bundle', command: '/not-invoked/adapter',
    supportsSystemInstructions: true, supportsReadOnly: true };
  const render = (subagentCommands) => renderArtifactPlan({
    ...context({ subagentCommands }), requestedArtifactIds: ['codex-subagent-guide-skill'],
  });
  const before = await render([initial]);
  const after = await render([{ ...initial, mode: 'workspace', supportsWorkspaceWrite: true }]);
  assert.deepEqual(externalRows(before), [['service', '已配置服务', 'bundle', true, true, false]]);
  assert.deepEqual(externalRows(after), [['service', '已配置服务', 'workspace', true, true, true]]);
  assert.deepEqual(externalRows(await render([])), []);
  assert.deepEqual(externalRows(await renderArtifactPlan(context())), []);
});

// Test Value Gate: configuration text must remain data, not inject Markdown rows or instructions.
test('escapes executor keys and titles without losing their configured values', async () => {
  const key = 'service|`<alias>';
  const title = '服务|`$&\n下一行<!-- data -->';
  const plan = await renderArtifactPlan({ ...context({ subagentCommands: [
    { key, title, mode: 'bundle', command: '/not-invoked/adapter',
      supportsSystemInstructions: true, supportsReadOnly: true },
  ] }), requestedArtifactIds: ['codex-subagent-guide-skill'] });
  assert.deepEqual(externalRows(plan), [[key, title, 'bundle', true, true, false]]);
});

// Test Value Gate: malformed whole objects cannot silently become a general/default profile.
test('does not fill missing properties in configured profile objects', async () => {
  for (const advisorDebugProfile of [{}, { model: 'incomplete' }, null]) {
    await assert.rejects(renderArtifactPlan(context({ advisorDebugProfile })));
  }
});

// Test Value Gate: escaped table values must remain data rather than adding columns or markup.
test('renders custom model and effort values as escaped data', async () => {
  const model = 'provider|alias`$&\nsecond-line<!-- unsafe -->';
  const configured = await renderArtifactPlan(context({ standardProfile: { model, reasoningEffort: 'max' } }));
  assert.deepEqual(profiles(skill(configured, 'codex-explore-skill')).standard,
    { profile: 'standardProfile', executor: 'native', model, reasoningEffort: 'max' });
});

test('preserves model-callable metadata for the three platform Skills', async () => {
  const plan = await renderArtifactPlan(context());
  for (const id of skillIds) {
    const artifact = plan.artifacts.find((item) => item.id === id);
    const yaml = await readFile(path.join(sourceRoot(id), 'agents/openai.yaml'), 'utf8');
    const text = artifact.content.files['SKILL.md'];
    // Static contract exception: Codex consumes invocation metadata and Skill frontmatter; behavior test is not suitable because this renderer does not run a Codex host.
    assert.match(yaml, /allow_implicit_invocation:\s*true/);
    assert.equal(text.match(/^name: (.+)$/m)?.[1], artifact.skillKey);
    const shortDescription = text.match(/^  short-description: (.+)$/m)?.[1];
    assert.ok(shortDescription);
    assert.equal(yaml.match(/short_description: "(.+)"/)?.[1], shortDescription);
    assert.ok([...shortDescription].length >= 25 && [...shortDescription].length <= 64);
    assert.doesNotMatch(text, /{{[^}]+}}/);
  }
});

// Test Value Gate: invalid requests must fail instead of delivering a broader artifact set.
test('rejects invalid target requests and unsupported platforms', async () => {
  for (const requestedArtifactIds of [[], ['codex-subagent-role', 'codex-subagent-role'], ['unknown']]) {
    await assert.rejects(renderArtifactPlan({ platform: 'codex', requestedArtifactIds }),
      /requestedArtifactIds|Unknown requested artifact/);
  }
  await assert.rejects(renderArtifactPlan({ ...context(), platform: 'claude' }), /Unsupported platform: claude/);
});
