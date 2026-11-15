import assert from 'node:assert/strict'

// This local management read proves Skill discovery, not session or model use.
export async function readCopilotSkills(ctx, cwd, expectedDescription, enabled) {
  const result = await ctx.command(['skill', 'list', '--json'], cwd)
  const items = JSON.parse(result.stdout)
  assert(Array.isArray(items), 'Copilot skills must be an array.')
  const matches = items.filter(item => item.name === ctx.skillName || item.name === `${ctx.pluginName}/${ctx.skillName}`)
  assert(matches.every(item => typeof item.enabled === 'boolean'), 'Copilot fixture Skill enablement must be explicit.')
  if (!enabled) {
    assert(!matches.some(item => item.enabled === true), 'A project Copilot Skill must not be enabled in neutral cwd.')
    return { level: 'skill-discovery', enabled: false, present: matches.length > 0 }
  }
  const enabledMatches = matches.filter(item => item.enabled === true)
  assert.equal(enabledMatches.length, 1, `Expected one Copilot enabled fixture Skill; found ${enabledMatches.length}.`)
  const skill = enabledMatches[0]
  assert.equal(skill.description, expectedDescription)
  assert.equal(typeof skill.path, 'string')
  return { level: 'skill-discovery', name: skill.name, description: skill.description, enabled: skill.enabled }
}
