import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertManualSkillRequests, createRoleScenario, withoutCuratedMarketplaceSync } from './native-platform-codex-behavior.mjs';

test('the loopback fixture restores the refresh lock when the turn fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-refresh-fixture-'));
  try {
    const home = path.join(root, 'codex');
    const lock = path.join(home, '.tmp', 'plugins.sync.lock');
    await fs.mkdir(path.dirname(lock), { recursive: true });
    await fs.writeFile(lock, 'existing test lock');
    const failure = new Error('turn failed');
    await assert.rejects(withoutCuratedMarketplaceSync({ root, env: { CODEX_HOME: home } }, async () => {
      assert((await fs.stat(lock)).isDirectory());
      throw failure;
    }), failure);
    assert.equal(await fs.readFile(lock, 'utf8'), 'existing test lock');
    assert.deepEqual(await fs.readdir(path.dirname(lock)), ['plugins.sync.lock']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

function messages(user, developer) {
  return { input: [{ role: 'user', content: [{ text: user }] }, { role: 'developer', content: [{ text: developer }] }] };
}

test('manual Skill evidence requires a populated implicit inventory and explicit input containing the body', () => {
  const skill = { name: 'plugin:manual', body: 'fixture Skill body' };
  const ordinary = messages('ordinary', 'aw-qualification-implicit-control');
  const explicit = messages('explicit', skill.body);
  assert.doesNotThrow(() => assertManualSkillRequests(ordinary, explicit, skill));
  assert.throws(() => assertManualSkillRequests(messages('ordinary', ''), explicit, skill), /implicit Skill inventory/u);
  assert.throws(() => assertManualSkillRequests(messages('ordinary', `aw-qualification-implicit-control ${skill.name}`), explicit, skill),
    /appeared in the ordinary inventory/u);
  assert.throws(() => assertManualSkillRequests(ordinary, messages('explicit', skill.name), skill), /load the projected body/u);
});

function response() {
  return { frames: [], writeHead(status) { assert.equal(status, 200); },
    write(chunk) { this.frames.push(JSON.parse(chunk.split('\ndata: ')[1])); }, end() {} };
}

function parent(scenario, advertisedRole, developer = 'ordinary parent instructions') {
  return { ...messages(scenario.prompt, developer), tools: [{ type: 'namespace', name: 'collaboration', tools: [
    { name: 'spawn_agent', parameters: { properties: { agent_type: { description: `${advertisedRole}: {\nDescription\n}` } } } },
  ] }] };
}

test('loopback role evidence requires exact native advertisement and installed instructions in a separate child', async () => {
  const role = { name: 'aw-qualification-role', instructions: 'installed role developer instructions' };
  const scenario = createRoleScenario(role, 1);
  await assert.rejects(scenario.respond(parent(scenario, `${role.name}-different`), response(), 1), /did not advertise/u);
  await assert.rejects(scenario.respond(parent(scenario, role.name, role.instructions), response(), 1), /parent turn/u);
  const parentResponse = response();
  await scenario.respond(parent(scenario, role.name), parentResponse, 1);
  const call = parentResponse.frames.find(frame => frame.type === 'response.output_item.done').item;
  const args = JSON.parse(call.arguments);
  assert.equal(call.namespace, 'collaboration');
  assert.equal(call.name, 'spawn_agent');
  assert.equal(args.agent_type, role.name);
  assert.equal(args.fork_turns, 'none');
  assert.throws(() => scenario.evidence(), /must start a native child/u);
  const child = (user, developer) => {
    const body = messages(user, developer);
    body.input.push({ type: 'agent_message', content: [{ text: args.message }] });
    return body;
  };
  assert.equal(scenario.matches(child('', role.instructions)), true);
  await assert.rejects(scenario.respond(child(scenario.prompt, role.instructions), response(), 2), /isolated child turn/u);
  await assert.rejects(scenario.respond(child('', 'default role instructions'), response(), 2), /did not receive the installed role/u);
  const followup = messages(scenario.prompt, 'ordinary parent instructions');
  await assert.rejects(scenario.respond(followup, response(), 3), /did not return its requested child task/u);
  followup.input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ task_name: `/root/${args.task_name}` }) });
  await Promise.all([scenario.respond(followup, response(), 3), scenario.respond(child('', role.instructions), response(), 2)]);
  assert.deepEqual(scenario.evidence(), { role: role.name, nativeSpawnTool: 'collaboration.spawn_agent', advertisedByHost: true,
    installedInstructionsLoadedInChild: true });
});
