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

// Test Value Gate: real declared roles can be projected without exporting Codex models or tools;
// unavailable Pi consumers produce unmet, and never an execution tool.
test('offers neutral roles on other hosts and records missing execution consumers', async () => {
  for (const platform of ['claude', 'antigravity', 'cursor', 'opencode', 'pi', 'gemini', 'copilot', 'grok']) {
    const plan = await renderArtifactPlan(context({}, platform));
    assert.deepEqual(plan.components.map((item) => item.id), roleIds);
    assert.deepEqual(plan.unmet.map((item) => [item.id, item.reasonCode]), skillIds.map((id) => [id, 'dependency-unmet']));
    assert.doesNotMatch(JSON.stringify(plan.components), /gpt-6|spawn_agent|registerTool/);
  }
  const declaration = context({}, 'pi', ['agent']);
  declaration.platformCapabilities.features['agent.declaration-protocol'] = { status: 'unverified', reasonCodes: ['capability-unverified'], values: [] };
  assert.deepEqual((await renderArtifactPlan(declaration)).unmet[0].requiredFeatures,
    [{ feature: 'agent.declaration-protocol', values: ['aw.pi.agents.v1'] }]);
  const missing = context({}, 'pi', ['agent']);
  missing.platformCapabilities.kinds.agent = { status: 'unsupported', reasonCodes: ['consumer-missing'], delivery: ['native-package'] };
  missing.platformCapabilities.features['agent.execution'] = { status: 'unsupported', reasonCodes: ['consumer-missing'], values: [] };
  const plan = await renderArtifactPlan(missing);
  assert.deepEqual(plan.components, []);
  assert.deepEqual(plan.unmet.map((item) => [item.id, item.reasonCode, item.requiredFeatures]), roleIds.map((id) =>
    [id, 'consumer-missing', [{ feature: 'component.kind.agent' }, { feature: 'agent.execution', values: ['isolated-context'] }]]));
});
