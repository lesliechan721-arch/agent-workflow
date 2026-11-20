import assert from 'node:assert/strict';
import test from 'node:test';
import { assertManualSkillTurns } from './native-platform-copilot-grok-manual.mjs';

const skill = { name: 'git-commit', description: 'Explicit approval and commit', body: 'Body loaded from the installed Skill.' };
const ordinary = 'AW_NATIVE_QUALIFICATION_ORDINARY_TURN';
const explicit = 'AW_NATIVE_QUALIFICATION_EXPLICIT_TURN';
const control = 'aw-implicit-skill-control';

function request(prompt, messages = [], tools = []) {
  return { model: 'gpt-4.1', messages: [{ role: 'user', content: prompt }, ...messages], tools };
}

const copilotInventory = content => ({ role: 'system', content: `<available_skills>${content}</available_skills>` });
const grokInventory = content => ({ role: 'user', content: `<system-reminder>The following skills are available for use: ${content}</system-reminder>` });

// Test Value Gate: the same positive/negative model-boundary checks also run in
// the real qualification. Fake requests only catch regressions in its verdict.
test('Copilot requires a positive automatic control, explicit body and active model tool denial', () => {
  const options = { ...skill, platform: 'copilot' };
  const initial = request(ordinary, [copilotInventory(control)]);
  const denial = request(ordinary, [{ role: 'tool', content: `Skill "${skill.name}" not found. Available skills: ${control}` }]);
  const selection = request(`${explicit}\n<skill-context>${skill.body}</skill-context>`);
  assert.doesNotThrow(() => assertManualSkillTurns([initial, denial, selection], options));
  assert.throws(() => assertManualSkillTurns([denial, selection], options), /advertise the implicit control/);
  assert.throws(() => assertManualSkillTurns([initial, selection], options), /refuse a direct model tool request/);
  assert.throws(() => assertManualSkillTurns([initial, denial, request(`${explicit} /${skill.name}`)], options), /must load the installed Skill body/);
});

test('Grok rejects any model-bound automatic exposure even when explicit loading succeeds', () => {
  const options = { ...skill, platform: 'grok' };
  const initial = request(ordinary, [grokInventory(control)]);
  const selection = request(`${explicit}\n<skill_information>${skill.body}</skill_information>`);
  assert.doesNotThrow(() => assertManualSkillTurns([initial, selection], options));
  const advertised = request(ordinary, [grokInventory(`${control}\n${skill.name}`)]);
  assert.throws(() => assertManualSkillTurns([advertised, selection], options), /exposed the manual Skill/);
  const leakedDescription = request(ordinary, [], [{ function: { name: 'skill', description: skill.name } }]);
  assert.throws(() => assertManualSkillTurns([initial, leakedDescription, selection], options), /exposed the manual Skill/);
});
