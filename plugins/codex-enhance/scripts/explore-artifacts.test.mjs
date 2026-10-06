import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { CONFIG_KEYS, computeResourceVersion, renderArtifactPlan, trimBlock } from './render-artifacts.mjs';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const ids = ['codex-explore-skill', 'codex-explore-role', 'codex-subagent-guide-skill',
  'codex-subagent-role', 'codex-advisor-skill', 'codex-advisor-role'];
const skillIds = ids.filter((id) => id.endsWith('-skill'));
function sourceRoot(id) {
  const staged = path.join(root, '.agents-plugin/artifact-sources/codex', id, '0');
  return existsSync(staged) ? staged : path.join(root, 'skills', id.replace(/-skill$/, ''));
}

function context(values = {}, revision = 'effective-revision-1') {
  return {
    platform: 'codex', scope: 'user', requestedArtifactIds: ids,
    artifactSources: skillIds.map((id) => ({ id, target: 'codex.skill', sourceDirs: [sourceRoot(id)] })),
    config: { values }, runtimeConfig: Object.fromEntries(skillIds.map((id) => [id, {
      revision, resourceVersion: 'resource-test-version',
    }])),
  };
}

function artifact(plan, id) {
  const found = plan.artifacts.find((item) => item.id === id);
  assert.ok(found, `Missing artifact ${id}`);
  return found;
}

function profiles(text) {
  return Object.fromEntries(text.split('\n').filter((line) => /^\| (quick|standard|deep) \|/.test(line))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      return [cells[1], Object.fromEntries(['profile', 'worker', 'executor', 'model', 'reasoningEffort']
        .map((key, i) => [key, JSON.parse(cells[i + 3].slice(1, -1))]))];
    }));
}

// Test Value Gate: actual renderer output protects exact target delivery, complete
// instruction transport, runtime resource reachability and config data boundaries.
test('real renderer entry emits six artifacts and the same canonical instructions for both channels', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-enhance-render-'));
  try {
    const input = path.join(temporary, 'context.json');
    await writeFile(input, JSON.stringify(context()));
    const { stdout, stderr } = await execFileAsync(process.execPath,
      [path.join(root, 'scripts/render-artifacts.mjs')], {
        env: { ...process.env, AW_PLUGIN_CONTEXT: input }, cwd: temporary,
      });
    assert.equal(stderr, '');
    const plan = JSON.parse(stdout);
    assert.equal(plan.version, 2);
    assert.deepEqual(plan.artifacts.map((item) => item.id), ids);
    const files = artifact(plan, 'codex-subagent-guide-skill').content.files;
    const binding = JSON.parse(files['runtime/worker-bindings.json']);
    assert.equal(binding.schemaVersion, 1);
    assert.equal(binding.protocolVersion, 2);
    for (const [key, roleId, roleKey] of [
      ['task', 'codex-subagent-role', 'codex-subagent'],
      ['advisor', 'codex-advisor-role', 'codex-advisor'],
      ['explore', 'codex-explore-role', 'codex-explore'],
    ]) {
      const source = existsSync(path.join(root, 'worker-instructions')) ? root : path.join(root, 'codex');
      const canonical = await readFile(path.join(source, 'worker-instructions', `${key}.md`), 'utf8');
      const role = artifact(plan, roleId);
      assert.equal(role.roleKey, roleKey);
      assert.equal(role.content.roleFile.name, roleKey);
      assert.equal(role.content.roleFile.developer_instructions, canonical);
      // Static contract exception: removing the worker read-only and delegation limits would widen the model's task authority; behavior test is not suitable because a deterministic renderer cannot execute model tool decisions.
      if (key === 'task') {
        assert.match(canonical, /默认只读/);
        assert.match(canonical, /进一步委派只适用于本次明确授予的有界协调职责/);
      } else {
        assert.match(canonical, /保持只读/);
        assert.match(canonical, /不启动其他代理|不委派其他代理/);
        assert.match(canonical, /不覆盖本次角色或权限|不改变任务、角色或许可/);
      }
      assert.equal(Object.hasOwn(role.content.roleFile, 'model'), false);
      assert.equal(Object.hasOwn(role.content.roleFile, 'model_reasoning_effort'), false);
      assert.deepEqual(role.refreshKeys, []);
      const worker = binding.workers.find((item) => item.key === key);
      assert.equal(files[worker.instructionsFile], canonical);
      assert.equal(worker.instructionRevision, createHash('sha256').update(canonical).digest('hex'));
      assert.equal(worker.nativeRole, roleKey);
      if (key !== 'task') {
        assert.equal(worker.maximumAccess, 'read-only');
        assert.equal(worker.allowDelegation, false);
      }
    }
    for (const id of skillIds) {
      const skill = artifact(plan, id);
      assert.deepEqual(skill.refreshKeys, CONFIG_KEYS);
      assert.equal(skill.content.files['SKILL.md'].includes('effective-revision-1'), true);
      assert.doesNotMatch(skill.content.files['SKILL.md'], /<!-- (?:generic-profiles|execution-revision|advisor-policy|advisor-binding|explore-bindings) -->/);
      if (id !== 'codex-subagent-guide-skill') {
        assert.equal(skill.content.files['runtime/worker-bindings.json'], undefined);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('requested subsets are exact and role-only never needs config or runtime binding', async () => {
  for (const id of ids) {
    const input = { ...context(), requestedArtifactIds: [id] };
    if (id.endsWith('-role')) {
      delete input.runtimeConfig;
      Object.defineProperty(input, 'config', { get() { throw new Error('role-only read config'); } });
    }
    assert.deepEqual((await renderArtifactPlan(input)).artifacts.map((item) => item.id), [id]);
  }
  const reversed = [...ids].reverse();
  assert.deepEqual((await renderArtifactPlan({ ...context(), requestedArtifactIds: reversed }))
    .artifacts.map((item) => item.id), reversed);
});

test('renders legacy and configured model/effort as escaped data with shared revision', async () => {
  const defaults = await renderArtifactPlan(context());
  const model = 'provider|alias`$&\nsecond-line<!-- unsafe -->';
  const configured = await renderArtifactPlan(context({
    standardProfile: { model, reasoningEffort: 'max' },
  }, 'effective-revision-2'));
  const selected = profiles(artifact(configured, 'codex-explore-skill').content.files['SKILL.md']);
  assert.deepEqual(selected.standard, {
    profile: 'standardProfile', worker: 'explore', executor: 'native', model, reasoningEffort: 'max',
  });
  assert.deepEqual(selected.quick, profiles(artifact(defaults, 'codex-explore-skill').content.files['SKILL.md']).quick);
  for (const id of ids.filter((id) => id.endsWith('-role'))) {
    assert.deepEqual(artifact(configured, id), artifact(defaults, id));
  }
  const alternate = context();
  alternate.config = undefined;
  alternate.renderConfig = { values: { standardProfile: { executor: 'native', model, reasoningEffort: 'high' } } };
  assert.equal(profiles(artifact(await renderArtifactPlan(alternate), 'codex-explore-skill')
    .content.files['SKILL.md']).standard.model, model);
});

test('public manifest preserves old identities and declares new config/runtime requirements', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.config.schemaVersion, 3);
  assert.deepEqual(new Set(Object.keys(manifest.config.fields)), new Set(CONFIG_KEYS));
  assert.deepEqual(manifest.artifacts.targets.map((item) => item.id), ids);
  const profile = manifest.config.definitions?.agentProfile ?? manifest.config.fields.standardProfile;
  assert.equal(profile.additionalProperties, false);
  assert.deepEqual(Object.keys(profile.properties), ['executor', 'model', 'reasoningEffort']);
  assert.deepEqual(profile.properties.executor.valueRef, {
    field: 'subagentCommands', key: 'key', label: 'title', include: ['native'],
  });
  assert.notEqual(profile.properties.executor.required, true);
  assert.equal(profile.properties.model.required, true);
  assert.equal(profile.properties.reasoningEffort.required, true);
  assert.equal(profile.properties.model.choices.allowCustom, true);
  assert.equal(profile.properties.reasoningEffort.choices.allowCustom, true);
  assert.deepEqual(profile.properties.reasoningEffort.choices.presets.map((item) => item.value),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(manifest.config.fields.advisorPolicy.default,
    { mode: 'conservative', maxConsultations: 2, focus: '' });
  assert.deepEqual(manifest.config.fields.advisorPolicy.properties.maxConsultations.validation,
    { integer: true, minimum: 1 });
  assert.deepEqual(manifest.config.fields.subagentCommands.default, []);
  assert.equal(manifest.config.fields.subagentCommands.validation.uniqueBy, 'key');
  assert.deepEqual(manifest.marketplace.policy.products, ['CODEX']);
  for (const capability of ['aw.plugin-config-unique-by.v1', 'aw.plugin-config-value-ref.v1',
    'aw.installed-runtime-config.v1']) assert.ok(manifest.requires.aw.capabilities.includes(capability));
  const runtimeVersions = new Set();
  for (const target of manifest.artifacts.targets) {
    if (target.target === 'codex.skill') {
      assert.deepEqual(target.delivery, { mode: 'codex-native', identity: 'shared', renderProfile: 'user' });
      assert.deepEqual(target.refreshKeys, CONFIG_KEYS);
      assert.deepEqual(target.runtimeConfig.keys, CONFIG_KEYS);
      assert.deepEqual(target.runtimeConfig.artifactIds, skillIds);
      runtimeVersions.add(target.runtimeConfig.resourceVersion);
    } else {
      assert.deepEqual(target.refreshKeys, []);
      assert.equal(target.runtimeConfig, undefined);
    }
  }
  assert.equal(runtimeVersions.size, 1);
});

test('rejects missing or mixed Skill runtime revision before producing a plan', async () => {
  await assert.rejects(renderArtifactPlan({ ...context(), runtimeConfig: undefined }), /runtimeConfig/);
  const mixed = context();
  mixed.runtimeConfig['codex-advisor-skill'].revision = 'other-revision';
  await assert.rejects(renderArtifactPlan(mixed), /consistent execution revision/);
});

test('declared resource version binds current instruction, protocol and execution sources deterministically', async () => {
  const version = await computeResourceVersion(context());
  assert.match(version, /^[a-f0-9]{64}$/);
  assert.equal(await computeResourceVersion(context()), version);
  const manifest = JSON.parse(await readFile(path.join(root, '.agents-plugin/plugin.json'), 'utf8'));
  for (const target of manifest.artifacts.targets.filter((item) => item.target === 'codex.skill')) {
    assert.equal(target.runtimeConfig.resourceVersion, version,
      'Source changes must update the shared declared resource version before build.');
  }
});

test('trimBlock keeps intentional nested indentation', () => {
  assert.equal(trimBlock('\n    first\n      second\n\n    third\n'), 'first\n  second\n\nthird');
});
