import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONFIG_KEYS, SKILL_CONFIG_KEYS, renderArtifactPlan } from './render-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceManifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
const defaultValues = Object.fromEntries(Object.entries(sourceManifest.config.fields)
  .filter(([, field]) => Object.hasOwn(field, 'default')).map(([key, field]) => [key, field.default]));
// This profile controls script tests only and does not qualify a real client.
function context(values = {}, platform = 'codex', scope = 'user', allowedOutputKinds = ['skill', 'agent']) {
  return { schemaVersion: 2, surface: 'agent-plugin', platform, scope, allowedOutputKinds,
    plugin: { pluginId: 'fixture/agent-subagent' },
    changedConfigKeys: [], previousComponents: [],
    resources: [{ kind: 'bundle', name: './skills/spawn-subagent', root: path.join(root, 'skills/spawn-subagent'), digest: 'test-resource' }],
    platformCapabilities: { schemaVersion: 2, platform, scope, basis: 'profile', deliveryFeatures: [],
      kinds: Object.fromEntries(['skill', 'mcp', 'agent', 'hook', 'instruction'].map((kind) => [kind,
        { status: 'supported', reasonCodes: [], delivery: ['native-package'] }])),
      features: { 'agent.execution': { status: 'supported', reasonCodes: [], values: ['isolated-context'] },
        'agent.prompt-mode': { status: 'supported', reasonCodes: [], values: ['host-default'] },
        'agent.declaration-protocol': { status: 'supported', reasonCodes: [], values: ['aw.pi.agents.v1'] } } },
    config: { values: { ...structuredClone(defaultValues), ...values } } };
}
async function files(plan) {
  const resources = plan.components.find((item) => item.kind === 'skill').content.files;
  return Object.fromEntries(await Promise.all(Object.entries(resources).map(async ([name, value]) => [name,
    'text' in value ? value.text : await readFile(path.join(root, value.source.path), 'utf8')])));
}
function rows(text, first) {
  const lines = text.split('\n'), start = lines.findIndex((line) => line.startsWith(first));
  if (start < 0) return [];
  const result = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    result.push(line.split('|').slice(1, -1).map((cell) => {
      const value = cell.trim(); return value.startsWith('`') ? JSON.parse(value.slice(1, -1)) : value;
    }));
  }
  return result;
}

// Test Value Gate: these parsed declarations are the configuration and platform delivery contracts.
test('owns generic configuration and one command package with platform-scoped invocation permissions', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'agent-subagent');
  assert.equal(manifest.config.schemaVersion, 5);
  assert.deepEqual(new Set(Object.keys(manifest.config.fields)), new Set([...CONFIG_KEYS, 'subagentRetentionHours']));
  const { definitions, fields, presentation } = manifest.config;
  const profile = definitions?.agentProfile ?? fields.generalTaskProfile;
  assert.equal(profile.additionalProperties, false);
  assert.equal(profile.variants.discriminator, 'executor');
  assert.equal(profile.variants.missing, 'native');
  for (const property of ['model', 'reasoningEffort']) {
    const native = profile.variants.cases.native.properties[property];
    const external = profile.variants.otherwise.properties[property];
    assert.equal(native.required, undefined);
    assert.equal(external.required, undefined);
  }
  const nativeProperties = profile.variants.cases.native.properties;
  const nativeModel = definitions?.nativeAgentModel ?? nativeProperties.model;
  const nativeEffort = definitions?.nativeAgentReasoningEffort ?? nativeProperties.reasoningEffort;
  assert.equal(nativeModel.choices, undefined);
  assert.equal(nativeEffort.choices, undefined);
  const codex = manifest.config.platforms.codex;
  const codexProperties = codex.fields?.generalTaskProfile.variants.cases.native.properties;
  const codexModel = codex.definitions?.nativeAgentModel ?? codexProperties.model;
  const codexEffort = codex.definitions?.nativeAgentReasoningEffort ?? codexProperties.reasoningEffort;
  assert.deepEqual(codexModel, definitions?.agentModel ?? profile.variants.otherwise.properties.model);
  assert.equal(codexEffort.choices.presets.some((entry) => entry.value === 'pro'), false);
  const executor = definitions?.agentExecutor ?? profile.properties.executor;
  assert.deepEqual(executor.valueRef, { field: 'subagentCommands', key: 'key', include: ['native'] });
  for (const key of ['simpleTaskProfile', 'generalTaskProfile', 'complexTaskProfile', 'advancedTaskProfile']) {
    assert.deepEqual(fields[key].default, { executor: 'native' });
  }
  assert.deepEqual(fields.taskCustomProfiles.default, []);
  assert.deepEqual(fields.taskCustomProfiles.items.variants, profile.variants);
  assert.equal(fields.taskCustomProfiles.items.properties.applicability.required, true);
  assert.deepEqual(fields.subagentCommands.default, []);
  assert.equal(fields.subagentCommands.validation.uniqueBy, 'key');
  assert.equal(fields.subagentRetentionHours.default, 24);
  assert.deepEqual(fields.subagentRetentionHours.validation, { integer: true, minimum: 0, maximum: 2501999792 });
  assert.deepEqual(presentation.groups.find((group) => group.id === 'spawn-subagent').fields,
    CONFIG_KEYS.filter((key) => !['subagentCommands', 'subagentRetentionHours'].includes(key)));
  assert.deepEqual(presentation.groups.find((group) => group.id === 'executors'), {
    id: 'executors', title: '外部执行器', fields: ['subagentCommands', 'subagentRetentionHours'], advanced: true,
  });
  assert.equal(manifest.schemaVersion, 4);
  assert.ok(manifest.platforms.includes('pi'));
  assert.ok(manifest.platforms.includes('grok'));
  assert.equal(Object.hasOwn(manifest.marketplace.policy, 'products'), false);
  assert.deepEqual(manifest.artifacts.configKeys, SKILL_CONFIG_KEYS['spawn-subagent']);
  assert.deepEqual(manifest.artifacts.sourceDirs, ['./skills/spawn-subagent']);
  assert.equal(Object.hasOwn(manifest.artifacts, 'targets'), false);
  const { sourceDir, platforms, mode, runtimeConfig, routes } = manifest.command;
  assert.equal(mode, 'static');
  assert.deepEqual(platforms, ['codex', 'claude']);
  assert.deepEqual(runtimeConfig, { keys: ['subagentCommands', 'subagentRetentionHours'] });
  assert.equal(routes.fallback, undefined);
  assert.deepEqual(routes.subcommands.map(({ name }) => name), ['start', 'send', 'wait', 'result', 'stop', 'message']);
  for (const launch of routes.subcommands) {
    const { name, runner, entry, args = [], env = {}, envFrom = {}, cwd = 'caller' } = launch;
    assert.deepEqual({ runner, entry, args, env, envFrom, cwd }, {
      runner: 'node', entry: name === 'message' ? 'scripts/message.mjs' : 'scripts/subagent.mjs',
      args: name === 'message' ? [] : [name], env: {}, envFrom: {}, cwd: 'caller',
    });
    assert.ok(await readFile(path.join(root, sourceDir, entry)));
  }
  assert.deepEqual(manifest.nativeTools.consumers, [
    { kind: 'plugin-command', tools: [{ key: 'windows-job', platforms: ['win32'], policy: 'required' }] },
    { kind: 'plugin-test', key: 'node', tools: [{ key: 'windows-job', platforms: ['win32'], policy: 'required' }] },
  ]);
  const [permission] = manifest.extensions.permissions;
  assert.equal(manifest.extensions.permissions.length, 1);
  for (const [platform, allow] of [['codex', permission.allow], ['claude', permission.agentOverrides.claude.allow]]) {
    assert.deepEqual(allow, [
      { argsPrefix: ['start', '--platform', platform] },
      { argsPrefix: ['send'] }, { argsPrefix: ['wait'] }, { argsPrefix: ['result'] }, { argsPrefix: ['stop'] },
    ]);
  }
  for (const platform of manifest.platforms.filter((platform) => !platforms.includes(platform))) {
    assert.equal(permission.agentOverrides[platform], null);
  }
  const managed = fields.subagentCommands.items.variants.cases['custom-managed'];
  assert.deepEqual(Object.keys(managed.properties), ['mode', 'commandId', 'subcommand']);
  assert.equal(managed.properties.commandId.required, true);
  assert.equal(managed.properties.subcommand.required, undefined);
  const pattern = new RegExp(managed.properties.commandId.validation.pattern);
  assert.equal(pattern.test('aw-official/agent-subagent'), true);
  assert.equal(pattern.test(`cmdp_${'a'.repeat(16)}`), false);
  assert.equal(pattern.test('cmdu_4ba70354-0867-4ecb-a927-120c1933f514'), true);
  assert.equal(pattern.test('guide'), false);
  const subcommand = new RegExp(managed.properties.subcommand.validation.pattern);
  assert.equal(subcommand.test('Group.start-v2_1'), true);
  assert.equal(subcommand.test('--help'), false);
});

// Test Value Gate: the rendered configuration must not invent native overrides or leak backend settings.
test('renders default inheritance, custom ordering, escaping and fixed adapter modes', async () => {
  const baseline = await files(await renderArtifactPlan(context()));
  assert.deepEqual(rows(baseline['references/execution-profiles.md'], '| 档位 |').map((row) => row.slice(2)),
    Array.from({ length: 4 }, () => ['native', '宿主默认', '宿主默认']));
  assert.deepEqual(rows(baseline['SKILL.md'], '| 档位 |'), []);
  const applicability = '数据库|锁`\n<details>';
  const key = 'service|`<alias>';
  const configured = await files(await renderArtifactPlan(context({
    generalTaskProfile: { executor: 'external' }, complexTaskProfile: { executor: 'native', model: 'one-model' },
    taskCustomProfiles: [{ applicability, executor: 'external' }, { applicability: '第二项' }],
    subagentCommands: [{ key, adapter: 'oracle', envFrom: { SECRET: 'HOST_SECRET' } },
      { key: 'codex', adapter: 'codex' }, { key: 'claude', adapter: 'claude-code' },
      { key: 'agy', adapter: 'antigravity' }, { key: 'custom', adapter: 'custom', mode: 'bundle', command: '/not-invoked/adapter' }],
  })));
  const profileRows = rows(configured['references/execution-profiles.md'], '| 档位 |');
  assert.deepEqual(profileRows.find((row) => row[0] === 'general').slice(2), ['external', '后端默认', '后端默认']);
  assert.deepEqual(profileRows.find((row) => row[0] === 'complex').slice(2), ['native', 'one-model', '宿主默认']);
  assert.deepEqual(rows(configured['references/execution-profiles.md'], '| 适用范围 |'),
    [[applicability, 'external', '后端默认', '后端默认'], ['第二项', 'native', '宿主默认', '宿主默认']]);
  assert.deepEqual(rows(configured['references/external-delegation.md'], '| key |'),
    [[key, 'bundle'], ['codex', 'workspace'], ['claude', 'workspace'], ['agy', 'workspace'], ['custom', 'bundle']]);
  assert.equal(configured['references/external-delegation.md'].includes('HOST_SECRET'), false);
  assert.equal(configured['references/external-delegation.md'].includes('/not-invoked/adapter'), false);
  assert.equal(configured['SKILL.md'], baseline['SKILL.md']);
  for (const body of Object.values(configured)) assert.doesNotMatch(body, /<!-- (?:generic-profiles|subagent-commands|subagent-retention|platform-status|codex-execution)/);
  const refreshed = await files(await renderArtifactPlan(context({ subagentCommands: [] })));
  assert.deepEqual(rows(refreshed['references/external-delegation.md'], '| key |'), []);
});

// Test Value Gate: generated command examples must match each platform's approved start invocation.
test('projects the common method and matching start platform to both scheduling hosts', async () => {
  for (const scope of ['user', 'project']) {
    const input = context({}, 'codex', scope);
    input.platformCapabilities.basis = 'local';
    const codex = await renderArtifactPlan(input);
    const generic = codex.components.find((artifact) => artifact.id === 'subagent-role');
    assert.equal(generic.name, 'subagent');
    assert.equal(generic.content.prompt, (await files(codex))['assets/task-instructions.md']);
    assert.equal(Object.hasOwn(generic.content, 'model'), false);
    const claude = await renderArtifactPlan(context({}, 'claude', scope));
    assert.deepEqual(claude.components.map((artifact) => artifact.id), ['spawn-subagent-claude-skill', 'subagent-role']);
    const codexFiles = await files(codex);
    assert.ok(codexFiles['SKILL.md'].includes('`aw-fixture-agent-subagent-subagent`'));
    const claudeFiles = await files(claude);
    for (const [platform, plan, output] of [['codex', codex, codexFiles], ['claude', claude, claudeFiles]]) {
      assert.equal(plan.components.find((item) => item.kind === 'skill').runtimeConfig, undefined);
      const calls = Object.values(output).flatMap((body) =>
        [...body.matchAll(/^\{\{aw\.command\}\} (.+)$/gm)].map(([, invocation]) => invocation.split(' ')));
      assert.deepEqual(calls.map(([action]) => action).sort(), ['result', 'send', 'start', 'stop', 'wait']);
      assert.deepEqual(calls.find(([action]) => action === 'start').slice(0, 3), ['start', '--platform', platform]);
    }
  }
});

// Test Value Gate: the installed Skill must resolve its referenced documents without command runtime files.
test('Codex delivered Skill retains its document closure', async () => {
  const output = await files(await renderArtifactPlan(context()));
  assert.equal(Object.keys(output).some((name) => name.startsWith('scripts/')), false);
  for (const [name, body] of Object.entries(output)) {
    const references = name.endsWith('.md') ? [...body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)] : [];
    for (const [, reference] of references) {
      if (/^[a-z][a-z0-9+.-]*:/.test(reference) || reference.startsWith('#')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), reference.split('#', 1)[0]));
      assert.equal(Object.hasOwn(output, target), true, `${name} -> ${reference}`);
    }
  }
});

// Test Value Gate: the scheduling Skill respects runtime prerequisites and role
// declarations remain available for projection when those prerequisites are absent.
test('returns complete role declarations independently of scheduling', async () => {
  const input = context({}, 'codex', 'user', ['skill']);
  input.changedConfigKeys = ['subagentCommands'];
  assert.deepEqual((await renderArtifactPlan(input)).components.map((item) => item.id), ['spawn-subagent-skill']);
  const roles = context({}, 'codex', 'user', ['agent']);
  Object.defineProperty(roles, 'config', { get() { throw new Error('role read config'); } });
  assert.deepEqual((await renderArtifactPlan(roles)).components.map((item) => item.id), ['subagent-role']);
  for (const platform of ['antigravity', 'cursor', 'opencode', 'pi', 'copilot', 'grok']) {
    const target = context({}, platform);
    target.platformCapabilities.kinds.agent.status = 'unverified';
    target.platformCapabilities.features['agent.execution'] = { status: 'unverified', reasonCodes: ['capability-unverified'] };
    const plan = await renderArtifactPlan(target);
    assert.deepEqual(plan.components.map((item) => item.id), ['subagent-role']);
    assert.deepEqual(plan.omitted, [{ id: 'spawn-subagent-skill', kind: 'skill', reason: 'not-offered' }]);
    assert.deepEqual(plan.unmet, []);
    assert.doesNotMatch(JSON.stringify(plan.components), /registerTool|spawn_agent|gpt-/);
  }
  const pi = context({}, 'pi', 'user', ['agent']);
  const piWithConsumer = await renderArtifactPlan(pi);
  const consumerMissing = { status: 'unsupported', reasonCodes: ['consumer-missing'] };
  pi.platformCapabilities.kinds.agent = { ...consumerMissing, delivery: ['native-extension'] };
  for (const feature of ['agent.execution', 'agent.prompt-mode', 'agent.declaration-protocol']) {
    pi.platformCapabilities.features[feature] = consumerMissing;
  }
  const piWithoutConsumer = await renderArtifactPlan(pi);
  assert.deepEqual(piWithoutConsumer, piWithConsumer);
  const [piRole] = piWithoutConsumer.components;
  assert.equal(piRole.content.prompt, await readFile(path.join(root, 'skills/spawn-subagent/assets/task-instructions.md'), 'utf8'));
  assert.deepEqual(piRole.requires.at(-1), { feature: 'agent.declaration-protocol', values: ['aw.pi.agents.v1'] });
  delete pi.platformCapabilities.deliveryFeatures;
  const legacy = await renderArtifactPlan(pi);
  assert.equal(legacy.components.length, 0);
  assert.equal(legacy.unmet[0].reasonCode, 'consumer-missing');
  await assert.rejects(renderArtifactPlan({ ...context(), platform: 'other' }));
  await assert.rejects(renderArtifactPlan({ ...context(), platform: undefined }));
  await assert.rejects(renderArtifactPlan({ ...context(), surface: 'agent-commands' }), /surface=agent-plugin/);
  const incomplete = context();
  delete incomplete.config.values.generalTaskProfile;
  await assert.rejects(renderArtifactPlan(incomplete), /Missing resolved config value: generalTaskProfile/);
});
