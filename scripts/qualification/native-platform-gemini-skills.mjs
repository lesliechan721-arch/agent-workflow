import assert from 'node:assert/strict'

// Gemini 0.67.0 exposes local discovery through this management command.
export async function readGeminiSkills(ctx, cwd, expectedDescription, present) {
  const result = await ctx.command(['skills', 'list'], cwd)
  assert.equal(typeof result.stdout, 'string', 'Gemini Skill discovery must return text.')
  const text = result.stdout.replace(/\r\n/gu, '\n').replace(/\n+$/u, '')
  const matches = []
  if (text !== 'No skills discovered.') {
    const heading = 'Discovered Agent Skills:\n\n'
    assert(text.startsWith(heading), 'Gemini must return the fixed Skill list format.')
    const blocks = text.slice(heading.length).split(/\n{2,}/u)
    assert(blocks.every(block => block.length > 0), 'Gemini Skill list must contain records.')
    for (const block of blocks) {
      const lines = block.split('\n')
      const header = /^(.+) \[([^\]\n]+)\]$/u.exec(lines[0])
      assert(header && lines.slice(1).every(line => line.startsWith('  ')),
        'Gemini Skill list contains an unknown record format.')
      if (header[1] === ctx.skillName) matches.push({ state: header[2], lines })
    }
  }
  assert.equal(matches.length, present ? 1 : 0,
    present ? 'Gemini must discover exactly one fixture Skill.' : 'Gemini must not retain the fixture in Skill discovery.')
  if (present) {
    const { state, lines } = matches[0]
    assert.equal(state, 'Enabled', 'Gemini must discover the enabled fixture Skill.')
    assert.equal(lines.length, 3, 'Gemini fixture Skill must use the fixed record format.')
    assert.equal(lines[1], `  Description: ${expectedDescription}`,
      'Gemini must discover the current fixture Skill description.')
    // The path is inventory text, not a qualification of file contents or scope.
    assert.match(lines[2], /^  Location: {4}.*$/u)
  }
  return { level: 'skill-discovery', name: ctx.skillName, present, ...(present ? { description: expectedDescription } : {}) }
}
