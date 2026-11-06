import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONFIG_KEYS, SKILL_CONFIG_KEYS, renderArtifactPlan } from './render-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const codexIds = ['spawn-subagent-skill', 'subagent-role'];
const sourceManifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
const defaultValues = Object.fromEntries(Object.entries(sourceManifest.config.fields)
  .filter(([, field]) => Object.hasOwn(field, 'default')).map(([key, field]) => [key, field.default]));
function context(values = {}, platform = 'codex', scope = 'user') {
  const id = platform === 'codex' ? codexIds[0] : 'spawn-subagent-claude-skill';
  const staged = path.join(root, '.agents-plugin/artifact-sources', platform, id, '0');
  const source = existsSync(staged) ? staged : path.join(root, 'skills/spawn-subagent');
  return { platform, scope, requestedArtifactIds: platform === 'codex' ? codexIds : [id],
    artifactSources: [{ id, target: `${platform}.skill`, sourceDirs: [source] }],
    config: { values: { ...structuredClone(defaultValues), ...values } } };
}
function files(plan) { return plan.artifacts.find((item) => item.kind === 'skill').content.files; }
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
test('owns generic configuration, optional native overrides and Codex command producers', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'agent-subagent');
  assert.equal(manifest.config.schemaVersion, 5);
  assert.deepEqual(new Set(Object.keys(manifest.config.fields)), new Set(CONFIG_KEYS));
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
  assert.deepEqual(manifest.platforms, ['codex', 'claude']);
  assert.equal(Object.hasOwn(manifest.marketplace.policy, 'products'), false);
  assert.deepEqual(manifest.artifacts.targets.map((target) => target.id), [...codexIds, 'spawn-subagent-claude-skill']);
  for (const target of manifest.artifacts.targets) {
    const expectedScopes = process.env.AW_PLUGIN_CONTEXT && target.target.endsWith('.skill')
      ? ['user'] : ['user', 'project'];
    assert.deepEqual(target.scopes, expectedScopes);
    if (target.target.endsWith('.skill')) {
      assert.deepEqual(target.sourceDirs, ['./skills/spawn-subagent']);
      assert.deepEqual(target.refreshKeys, SKILL_CONFIG_KEYS['spawn-subagent']);
    }
    if (target.target === 'codex.skill') {
      assert.equal(Object.hasOwn(target, 'delivery'), false);
      assert.deepEqual(target.runtimeConfig, { keys: ['subagentCommands', 'subagentRetentionHours'] });
    }
    if (target.platform === 'claude') assert.deepEqual(target.runtimeConfig, { keys: ['subagentCommands', 'subagentRetentionHours'] });
  }
  assert.deepEqual(manifest.managedCommands.packages ?? [], []);
  assert.deepEqual(manifest.managedCommands.sets.map((set) => set.set), ['guide', 'guide-communication', 'guide-claude', 'guide-communication-claude']);
  for (const set of manifest.managedCommands.sets) {
    assert.deepEqual(set.producer, { kind: 'artifact', artifactId: set.set.endsWith('-claude') ? 'spawn-subagent-claude-skill' : 'spawn-subagent-skill' });
  }
  const communicationEntries = manifest.managedCommands.sets[1].entries;
  assert.equal(communicationEntries.length, 1);
  const { args = [], env = {}, envFrom = {}, variant = 'default', cwd = 'caller', ...communicationEntry } = communicationEntries[0];
  assert.deepEqual(communicationEntry, { key: 'message', runner: 'node', entry: 'scripts/message.mjs' });
  // Source may omit launch defaults; a normalized bundle can make them explicit.
  assert.deepEqual({ args, env, envFrom, variant, cwd },
    { args: [], env: {}, envFrom: {}, variant: 'default', cwd: 'caller' });
  const permission = manifest.extensions.permissions[0];
  assert.deepEqual(permission.allow.map((entry) => entry.argsPrefix[0]), ['start', 'send', 'wait', 'result', 'stop']);
  assert.equal(permission.agentOverrides.claude, null);
  const managed = fields.subagentCommands.items.variants.cases['custom-managed'];
  assert.deepEqual(Object.keys(managed.properties), ['mode', 'commandId']);
  assert.equal(managed.properties.commandId.required, true);
  const pattern = new RegExp(managed.properties.commandId.validation.pattern);
  assert.equal(pattern.test(`cmdp_${'a'.repeat(16)}`), true);
  assert.equal(pattern.test('cmdu_4ba70354-0867-4ecb-a927-120c1933f514'), true);
  assert.equal(pattern.test('guide'), false);
});

// Test Value Gate: the rendered configuration must not invent native overrides or leak backend settings.
test('renders default inheritance, custom ordering, escaping and fixed adapter modes', async () => {
  const baseline = files(await renderArtifactPlan(context()));
  assert.deepEqual(rows(baseline['references/execution-profiles.md'], '| 档位 |').map((row) => row.slice(2)),
    Array.from({ length: 4 }, () => ['native', '宿主默认', '宿主默认']));
  assert.deepEqual(rows(baseline['SKILL.md'], '| 档位 |'), []);
  const applicability = '数据库|锁`\n<details>';
  const key = 'service|`<alias>';
  const configured = files(await renderArtifactPlan(context({
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
  const refreshed = files(await renderArtifactPlan(context({ subagentCommands: [] })));
  assert.deepEqual(rows(refreshed['references/external-delegation.md'], '| key |'), []);
});

// Test Value Gate: both platforms retain one method and full runtime resources; only managed producer identities differ.
test('projects the common method and runtime to both platforms and scopes', async () => {
  for (const scope of ['user', 'project']) {
    const codex = await renderArtifactPlan(context({}, 'codex', scope));
    const generic = codex.artifacts.find((artifact) => artifact.id === 'subagent-role');
    assert.equal(generic.roleKey, 'subagent');
    assert.equal(generic.content.roleFile.developer_instructions, files(codex)['assets/task-instructions.md']);
    assert.equal(Object.hasOwn(generic.content.roleFile, 'model'), false);
    const claude = await renderArtifactPlan(context({}, 'claude', scope));
    assert.deepEqual(claude.artifacts.map((artifact) => artifact.id), ['spawn-subagent-claude-skill']);
    const restored = Object.fromEntries(Object.entries(files(claude)).map(([name, body]) => [name,
      body.replaceAll('aw.command:guide-claude/', 'aw.command:guide/').replaceAll('aw.command:guide-communication-claude/', 'aw.command:guide-communication/')]));
    assert.deepEqual(restored, files(codex));
  }
});

// Test Value Gate: installed content must contain the referenced module and document closure.
test('Codex delivered resources retain their module and document closure', async () => {
  const output = files(await renderArtifactPlan(context()));
  for (const entry of ['subagent.mjs', 'worker.mjs', 'scan-expired.mjs', 'message.mjs', 'message-mcp.mjs',
    'adapters/codex-v5.mjs', 'adapters/codex-profile.mjs', 'adapters/claude-code-v5.mjs', 'adapters/antigravity-v5.mjs', 'adapters/oracle-v5.mjs']) {
    assert.equal(typeof output[`scripts/${entry}`], 'string');
  }
  for (const [name, body] of Object.entries(output)) {
    const references = name.endsWith('.md') ? [...body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
      : name.endsWith('.mjs') ? [...body.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"\n]+)['"]/g)] : [];
    for (const [, reference] of references) {
      if (name.endsWith('.mjs') ? !reference.startsWith('.') : /^[a-z][a-z0-9+.-]*:/.test(reference) || reference.startsWith('#')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), reference.split('#', 1)[0]));
      if (target === 'scripts/aw-runtime-config.mjs' || target === 'scripts/runtime/native-tool-reader.mjs') continue;
      assert.equal(Object.hasOwn(output, target), true, `${name} -> ${reference}`);
    }
  }
});

// Test Value Gate: malformed requests must not widen the delivered artifact set or read specialist config.
test('returns exact subsets and rejects invalid platform targets', async () => {
  const input = context();
  Object.defineProperty(input.config.values, 'advisorGeneralProfile', { get() { throw new Error('read specialist'); } });
  const plan = await renderArtifactPlan(input);
  for (const id of codexIds) {
    const subset = { ...input, requestedArtifactIds: [id] };
    if (id === 'subagent-role') Object.defineProperty(subset, 'config', { get() { throw new Error('role read config'); } });
    assert.deepEqual(await renderArtifactPlan(subset), { version: 2, artifacts: [plan.artifacts.find((artifact) => artifact.id === id)] });
  }
  for (const requestedArtifactIds of [[], ['subagent-role', 'subagent-role'], ['unknown']]) {
    await assert.rejects(renderArtifactPlan({ platform: 'codex', requestedArtifactIds }));
  }
  await assert.rejects(renderArtifactPlan({ ...context({}, 'claude'), requestedArtifactIds: codexIds }));
  await assert.rejects(renderArtifactPlan({ ...context(), platform: 'other' }));
  await assert.rejects(renderArtifactPlan({ ...context(), platform: undefined }));
  const incomplete = context();
  delete incomplete.config.values.generalTaskProfile;
  await assert.rejects(renderArtifactPlan(incomplete), /Missing resolved config value: generalTaskProfile/);
});
