import assert from 'node:assert/strict'
import test from 'node:test'
import { readCopilotSkills } from './native-platform-copilot-skills.mjs'

function fixture(stdout) {
  const calls = []
  const ctx = {
    pluginName: 'qualification-plugin',
    skillName: 'qualification-skill',
    async command(...args) {
      calls.push(args)
      return { stdout }
    },
  }
  return { ctx, calls }
}

function skill(overrides = {}) {
  return {
    name: 'qualification-skill',
    description: 'AW public acceptance revision 1',
    path: '/isolated/copilot/skills/qualification-skill/SKILL.md',
    enabled: true,
    ...overrides,
  }
}

// Test Value Gate: observe the real reader output and command boundary without
// launching a client; fresh cwd and current metadata must reach each read.
test('reads direct and plugin-qualified names with the caller description and cwd', async () => {
  const cases = [
    ['qualification-skill', 'AW public acceptance revision 1', '/isolated/project'],
    ['qualification-plugin/qualification-skill', 'AW public acceptance revision 2', '/isolated/fresh-project'],
  ]
  for (const [name, description, cwd] of cases) {
    const { ctx, calls } = fixture(JSON.stringify([
      skill({ name: 'unrelated-skill' }),
      skill({ enabled: false }),
      skill({ name, description }),
    ]))
    assert.deepEqual(await readCopilotSkills(ctx, cwd, description, true), {
      level: 'skill-discovery', name, description, enabled: true,
    })
    assert.deepEqual(calls, [[['skill', 'list', '--json'], cwd]])
  }
})

test('distinguishes explicitly disabled records from complete absence', async () => {
  for (const [rows, present] of [
    [[skill({ enabled: false })], true],
    [[], false],
    [[skill({ name: 'unrelated-skill' })], false],
  ]) {
    const { ctx, calls } = fixture(JSON.stringify(rows))
    assert.deepEqual(await readCopilotSkills(ctx, '/isolated/neutral', 'unused', false), {
      level: 'skill-discovery', enabled: false, present,
    })
    assert.equal(calls.length, 1)
  }
})

test('does not infer disabled state from missing or non-boolean enablement', async () => {
  for (const enabled of [undefined, null, 'false', 0]) {
    const { ctx } = fixture(JSON.stringify([skill({ enabled })]))
    await assert.rejects(readCopilotSkills(ctx, '/isolated/neutral', 'unused', false), { code: 'ERR_ASSERTION' })
  }
})

// Test Value Gate: an absent, disabled, duplicate or stale record must not
// become positive Skill discovery or a successful neutral-scope observation.
test('rejects enabled matches when the caller requires no enabled Skill', async () => {
  for (const name of ['qualification-skill', 'qualification-plugin/qualification-skill']) {
    const { ctx } = fixture(JSON.stringify([skill({ enabled: false }), skill({ name })]))
    await assert.rejects(readCopilotSkills(ctx, '/isolated/neutral', 'unused', false), { code: 'ERR_ASSERTION' })
  }
})

test('requires exactly one enabled matching Skill', async () => {
  const missingEnabled = skill()
  delete missingEnabled.enabled
  for (const rows of [[], [skill({ name: 'unrelated-skill' })], [skill({ enabled: false })], [missingEnabled],
    [skill(), skill({ name: 'qualification-plugin/qualification-skill' })]]) {
    const { ctx } = fixture(JSON.stringify(rows))
    await assert.rejects(readCopilotSkills(ctx, '/isolated/project', skill().description, true), { code: 'ERR_ASSERTION' })
  }
})

test('rejects an old description after a revision change', async () => {
  const { ctx } = fixture(JSON.stringify([skill()]))
  await assert.rejects(readCopilotSkills(ctx, '/isolated/project', 'AW public acceptance revision 2', true), {
    code: 'ERR_ASSERTION',
  })
})

test('rejects enabled Skill paths that are missing or not strings', async () => {
  for (const path of [undefined, null, 12, {}]) {
    const { ctx } = fixture(JSON.stringify([skill({ path })]))
    await assert.rejects(readCopilotSkills(ctx, '/isolated/project', skill().description, true), { code: 'ERR_ASSERTION' })
  }
})

// Test Value Gate: malformed output and command failure must propagate through
// the reader, including when the caller expects a Skill to be absent.
test('rejects malformed JSON and non-array output in both observation modes', async () => {
  for (const enabled of [true, false]) {
    const invalidJson = fixture('{broken')
    await assert.rejects(readCopilotSkills(invalidJson.ctx, '/isolated/project', 'expected', enabled), SyntaxError)
    for (const stdout of ['{}', 'null', '"skills"']) {
      const { ctx } = fixture(stdout)
      await assert.rejects(readCopilotSkills(ctx, '/isolated/project', 'expected', enabled), { code: 'ERR_ASSERTION' })
    }
  }
})

test('propagates the original command error without retry', async () => {
  for (const enabled of [true, false]) {
    const original = new Error('command failed')
    let calls = 0
    const ctx = {
      pluginName: 'qualification-plugin', skillName: 'qualification-skill',
      async command() { calls += 1; throw original },
    }
    await assert.rejects(readCopilotSkills(ctx, '/isolated/project', 'expected', enabled), error => error === original)
    assert.equal(calls, 1)
  }
})
