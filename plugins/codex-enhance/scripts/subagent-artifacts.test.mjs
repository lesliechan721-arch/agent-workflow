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
        .map((key, i) => [key, cells[i + 3].startsWith('`') ? JSON.parse(cells[i + 3].slice(1, -1)) : cells[i + 3]]))];
    }));
}

function externalRows(plan) {
  const text = plan.artifacts.find((item) => item.id === 'codex-subagent-guide-skill')
    .content.files['references/external-delegation.md'];
  assert.equal(typeof text, 'string');
  const lines = text.split('\n');
  const header = lines.findIndex((line) => line.startsWith('| key |'));
  if (header < 0) return [];
  const rows = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.split('|').slice(1, -1).map((cell) => JSON.parse(cell.trim().slice(1, -1))));
  }
  return rows;
}

// Test Value Gate: manifest JSON is the public configuration and delivery contract.
test('shares one profile definition, preserves defaults and declares exact consumer inputs', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.config.schemaVersion, 4);
  assert.deepEqual(new Set(Object.keys(manifest.config.fields)), new Set(CONFIG_KEYS));
  const profile = manifest.config.definitions?.agentProfile ?? manifest.config.fields.advisorProfile;
  if (manifest.config.definitions) {
    assert.deepEqual(new Set(Object.keys(manifest.config.definitions)), new Set(['agentProfile', 'agentModel', 'agentReasoningEffort']));
  }
  assert.equal(profile.additionalProperties, false);
  assert.deepEqual(Object.keys(profile.properties), ['executor']);
  assert.equal(profile.variants.discriminator, 'executor');
  assert.equal(profile.variants.missing, 'native');
  const effort = manifest.config.definitions?.agentReasoningEffort ?? profile.variants.otherwise.properties.reasoningEffort;
  assert.deepEqual(effort.choices.presets.find((preset) => preset.id === 'pro'), { id: 'pro', title: 'pro', value: 'pro' });
  const engine = manifest.config.fields.subagentCommands.items.variants.cases.oracle.properties.oracleEngine;
  assert.equal(engine.choices.presets.find((preset) => preset.value === 'browser').recommended, true);
  assert.equal(Object.hasOwn(engine, 'default'), false);
  assert.deepEqual(profile.properties.executor.valueRef, {
    field: 'subagentCommands', key: 'key', label: 'title', include: ['native'],
  });
  assert.notEqual(profile.properties.executor.required, true);
  for (const property of ['model', 'reasoningEffort']) {
    const native = profile.variants.cases.native.properties[property];
    const external = profile.variants.otherwise.properties[property];
    assert.equal(native.required, true);
    assert.equal(external.required, undefined);
    if (manifest.config.definitions) {
      assert.equal(native.$ref, external.$ref);
    } else {
      // Production manifests expand source references into the same scalar
      // contract while retaining the native branch's required property.
      assert.equal(native.type, 'string');
      const { required, ...nativeValue } = native;
      assert.deepEqual(nativeValue, external);
    }
  }
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
      assert.deepEqual(field.variants, profile.variants);
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
  assert.ok(manifest.requires.aw.capabilities.includes('aw.plugin-config.v4'));
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
    subagentCommands: [{ key: 'external-debug', title: 'Debug', adapter: 'custom', mode: 'workspace', command: '/adapter' }],
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

// Test Value Gate: delivered executor data must agree with fixed builtin modes,
// preserve custom modes and omit private commands and environment values.
test('renders adapter modes only in the Guide external reference', async () => {
  const subagentCommands = [
    { key: 'codex', title: '工程服务', adapter: 'codex', env: { PUBLIC_VALUE: 'literal-value' } },
    { key: 'claude', title: '本地服务', adapter: 'claude-code', mode: 'workspace' },
    { key: 'oracle', title: '材料服务', adapter: 'oracle', envFrom: { SECRET: 'HOST_SECRET' } },
    { key: 'custom', title: '自定义服务', adapter: 'custom', mode: 'bundle', command: '/not-invoked/adapter' },
  ];
  const expected = [
    ['codex', '工程服务', 'codex', 'workspace'],
    ['claude', '本地服务', 'claude-code', 'workspace'],
    ['oracle', '材料服务', 'oracle', 'bundle'],
    ['custom', '自定义服务', 'custom', 'bundle'],
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
    const reference = plan.artifacts.find((item) => item.id === 'codex-subagent-guide-skill')
      .content.files['references/external-delegation.md'];
    for (const privateValue of ['literal-value', 'HOST_SECRET', '/not-invoked/adapter']) {
      assert.equal(reference.includes(privateValue), false);
    }
  }
});

// Test Value Gate: refreshed artifacts must remove old executor data and mode.
test('refreshes executor data from each render request and handles an empty registry', async () => {
  const initial = { key: 'service', title: '已配置服务', adapter: 'custom', mode: 'bundle', command: '/not-invoked/adapter' };
  const render = (subagentCommands) => renderArtifactPlan({
    ...context({ subagentCommands }), requestedArtifactIds: ['codex-subagent-guide-skill'],
  });
  assert.deepEqual(externalRows(await render([initial])), [['service', '已配置服务', 'custom', 'bundle']]);
  assert.deepEqual(externalRows(await render([{ ...initial, mode: 'workspace' }])), [['service', '已配置服务', 'custom', 'workspace']]);
  assert.deepEqual(externalRows(await render([])), []);
  assert.deepEqual(externalRows(await renderArtifactPlan(context())), []);
});

// Test Value Gate: configured values must not inject Markdown columns or markup.
test('escapes executor keys and titles without losing their configured values', async () => {
  const key = 'service|`<alias>';
  const title = '服务|`$&\n下一行<!-- data -->';
  const plan = await renderArtifactPlan({ ...context({ subagentCommands: [
    { key, title, adapter: 'custom', mode: 'bundle', command: '/not-invoked/adapter' },
  ] }), requestedArtifactIds: ['codex-subagent-guide-skill'] });
  assert.deepEqual(externalRows(plan), [[key, title, 'custom', 'bundle']]);
});

// Test Value Gate: external omitted values must survive as backend defaults;
// one explicitly configured property must not fill the other from a native default.
test('renders omitted external model and effort without inventing configured values', async () => {
  const plan = await renderArtifactPlan(context({
    generalTaskProfile: { executor: 'external' },
    complexTaskProfile: { executor: 'external', model: 'backend-model' },
    advisorDebugProfile: { executor: 'external', reasoningEffort: 'high' },
  }));
  assert.deepEqual(profiles(skill(plan, 'codex-subagent-guide-skill')).general,
    { profile: 'generalTaskProfile', executor: 'external', model: '后端默认', reasoningEffort: '后端默认' });
  assert.deepEqual(profiles(skill(plan, 'codex-subagent-guide-skill')).complex,
    { profile: 'complexTaskProfile', executor: 'external', model: 'backend-model', reasoningEffort: '后端默认' });
  assert.deepEqual(profiles(skill(plan, 'codex-advisor-skill')).debug,
    { profile: 'advisorDebugProfile', executor: 'external', model: '后端默认', reasoningEffort: 'high' });
});

// Test Value Gate: malformed native profiles must not advertise backend defaults.
test('does not fill missing properties in configured native profile objects', async () => {
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
    const yaml = artifact.content.files['agents/openai.yaml'];
    assert.equal(typeof yaml, 'string');
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

// Test Value Gate: links in the actual artifact must reach delivered resources.
// This checks the installable file graph, not document wording or model behavior.
test('delivered Skill links resolve inside each artifact resource root', async () => {
  const plan = await renderArtifactPlan(context());
  for (const artifact of plan.artifacts) {
    const files = artifact.content.files;
    for (const [name, body] of Object.entries(files)) {
      if (!name.endsWith('.md')) continue;
      for (const [, reference] of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        if (/^[a-z][a-z0-9+.-]*:/.test(reference) || reference.startsWith('#')) continue;
        const target = reference.split('#', 1)[0];
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
        assert.equal(Object.hasOwn(files, resolved), true, `${artifact.skillKey}: ${name} -> ${reference}`);
      }
    }
  }
});

// Test Value Gate: an install can render successfully yet miss a worker or a
// helper import. Inspect the delivered module graph without starting a backend.
test('delivered Guide contains its executable entries and relative module closure', async () => {
  const plan = await renderArtifactPlan(context());
  const files = plan.artifacts.find((item) => item.id === 'codex-subagent-guide-skill').content.files;
  for (const entry of ['subagent.mjs', 'worker.mjs', 'message.mjs', 'message-mcp.mjs']) {
    assert.equal(typeof files[`scripts/${entry}`], 'string', `Missing executable entry: ${entry}`);
  }
  // The native helper is reached by URL at runtime and has no JavaScript import
  // edge. It must remain a byte-preserving resource of the installed Guide.
  assert.equal(files['scripts/runtime/windows-job.ps1'], await readFile(path.join(
    sourceRoot('codex-subagent-guide-skill'), 'scripts/runtime/windows-job.ps1'), 'utf8'));
  for (const [name, body] of Object.entries(files)) {
    if (!name.endsWith('.mjs')) continue;
    for (const [, reference] of body.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"\n]+)['"]/g)) {
      if (!reference.startsWith('.')) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), reference));
      // AW injects this reserved reader after rendering. The actual materialized
      // artifact is checked separately; a renderer must not supply its own copy.
      if (resolved === 'scripts/aw-runtime-config.mjs') continue;
      assert.equal(Object.hasOwn(files, resolved), true, `${name} -> ${reference}`);
    }
  }
});
