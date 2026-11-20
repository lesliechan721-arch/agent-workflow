import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderArtifactPlan } from './render-artifacts.mjs';
import { root, context, component, resourceText } from './render-test-context.mjs';

const execFileAsync = promisify(execFile);
const skillIds = ['codex-explore-skill', 'codex-advisor-skill'];
const roleIds = ['codex-explore-role', 'codex-advisor-role'];

// Test Value Gate: the real entry delivers v3, complete batches and shared role instructions.
test('real renderer returns complete component batches and preserves role prompts', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-enhance-render-'));
  try {
    const input = path.join(temporary, 'context.json');
    await writeFile(input, JSON.stringify(context()));
    const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(root, 'scripts/render-artifacts.mjs')], {
      env: { ...process.env, AW_PLUGIN_CONTEXT: input }, cwd: temporary,
    });
    assert.equal(stderr, '');
    const plan = JSON.parse(stdout);
    assert.equal(plan.version, 3);
    assert.deepEqual(plan.components.map((item) => item.id), [...skillIds, ...roleIds]);
    assert.deepEqual(plan.omitted, []);
    assert.deepEqual(plan.unmet, []);
    for (const key of ['codex-explore', 'codex-advisor']) {
      const filename = `assets/${key === 'codex-explore' ? 'explore' : 'advisor'}-instructions.md`;
      const canonical = await readFile(path.join(root, 'skills', key, filename), 'utf8');
      const role = component(plan, `${key}-role`);
      assert.equal(role.name, key);
      assert.equal(role.content.prompt.startsWith(`${canonical.trimEnd()}\n\n`), true);
      assert.match(role.content.prompt.slice(canonical.trimEnd().length), new RegExp(`不要通过 ${key} 将同一`));
      assert.equal(Object.hasOwn(role.content, 'model'), false);
      assert.equal(Object.hasOwn(role.content, 'tools'), false);
      assert.equal(await resourceText(component(plan, `${key}-skill`).content.files[filename]), canonical);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

// Test Value Gate: non-Skill permission batches never read config; changed keys never trim the set.
test('uses batch permissions and always returns the complete owned collection', async () => {
  const skillContext = context({}, 'codex', ['skill']);
  skillContext.changedConfigKeys = ['quickProfile'];
  assert.deepEqual((await renderArtifactPlan(skillContext)).components.map((item) => item.id), skillIds);
  const roleContext = context({}, 'codex', ['agent', 'mcp', 'hook', 'instruction']);
  Object.defineProperty(roleContext, 'config', { get() { throw new Error('non-Skill batch read config'); } });
  assert.deepEqual((await renderArtifactPlan(roleContext)).components.map((item) => item.id), roleIds);
  assert.deepEqual(await renderArtifactPlan(context({}, 'codex', ['mcp'])), { version: 3, components: [], omitted: [], unmet: [] });
  await assert.rejects(renderArtifactPlan({ ...context(), surface: 'managed-commands' }), /surface=agent-plugin/);
  await assert.rejects(renderArtifactPlan({ ...context({}, 'codex', ['agent']), resources: [] }), /Missing verified bundle resource/);
});

// Test Value Gate: complete role declarations remain available when runtime
// support is unknown or Pi consumers are missing. Scheduling remains Codex-only.
test('offers neutral role declarations independently of Codex scheduling', async () => {
  for (const platform of ['claude', 'antigravity', 'cursor', 'opencode', 'pi', 'copilot', 'grok']) {
    const target = context({}, platform);
    target.platformCapabilities.kinds.agent.status = 'unverified';
    target.platformCapabilities.features['agent.execution'] = { status: 'unverified', reasonCodes: ['capability-unverified'] };
    const plan = await renderArtifactPlan(target);
    assert.deepEqual(plan.components.map((item) => item.id), roleIds);
    assert.deepEqual(plan.omitted, skillIds.map((id) => ({ id, kind: 'skill', reason: 'not-offered' })));
    assert.deepEqual(plan.unmet, []);
    assert.doesNotMatch(JSON.stringify(plan.components), /gpt-6|spawn_agent|registerTool/);
  }
  const pi = context({}, 'pi', ['agent']);
  const piWithConsumer = await renderArtifactPlan(pi);
  const consumerMissing = { status: 'unsupported', reasonCodes: ['consumer-missing'] };
  pi.platformCapabilities.kinds.agent = { ...consumerMissing, delivery: ['native-extension'] };
  for (const feature of ['agent.execution', 'agent.prompt-mode', 'agent.declaration-protocol']) {
    pi.platformCapabilities.features[feature] = consumerMissing;
  }
  const piWithoutConsumer = await renderArtifactPlan(pi);
  assert.deepEqual(piWithoutConsumer, piWithConsumer);
  assert.deepEqual(piWithoutConsumer.components.map((item) => item.requires.at(-1)),
    roleIds.map(() => ({ feature: 'agent.declaration-protocol', values: ['aw.pi.agents.v1'] })));
  delete pi.platformCapabilities.deliveryFeatures;
  const legacy = await renderArtifactPlan(pi);
  assert.deepEqual(legacy.unmet.map(({ id }) => id), roleIds);
  assert.equal(legacy.components.length, 0);

  const noExecution = context();
  noExecution.platformCapabilities.features['agent.execution'] = { status: 'unverified', reasonCodes: ['capability-unverified'] };
  const codex = await renderArtifactPlan(noExecution);
  assert.deepEqual(codex.components.map((item) => item.id), roleIds);
  assert.deepEqual(codex.unmet.map(({ id, requiredFeatures, reasonCode }) => ({ id, requiredFeatures, reasonCode })),
    skillIds.map((id) => ({ id, requiredFeatures: [{ feature: 'agent.execution', values: ['isolated-context'] }], reasonCode: 'capability-unverified' })));
});
