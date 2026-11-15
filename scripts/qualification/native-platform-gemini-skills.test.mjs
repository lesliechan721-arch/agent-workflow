import assert from 'node:assert/strict'
import test from 'node:test'
import { readGeminiSkills } from './native-platform-gemini-skills.mjs'

const description = 'AW qualification revision 1'
const name = 'aw-qualification'
const location = '<TEMP_ROOT>/gemini/.gemini/extensions/aw-qualification/skills/aw-qualification/SKILL.md'

function record(skillName = name, skillDescription = description, state = 'Enabled') {
  return `${skillName} [${state}]\n  Description: ${skillDescription}\n  Location:    ${location}`
}

function list(...records) {
  return `Discovered Agent Skills:\n\n${records.join('\n\n')}\n\n`
}

function fixture(stdout, skillName = name) {
  const calls = []
  const ctx = {
    skillName,
    async command(...args) {
      calls.push(args)
      return { stdout }
    },
  }
  return { ctx, calls }
}

// Test Value Gate: observe the real reader and its single local management
// command; the fixed client evidence supplies the list format, not a client mock.
test('reads the fixture revision with LF or Windows CRLF and preserves the Native result', async () => {
  for (const [skillName, expectedDescription, cwd, newline] of [
    [name, description, '/isolated/project', '\n'],
    ['aw.qual+[fixture]', 'AW qualification revision 2', 'C:\\isolated\\neutral', '\r\n'],
  ]) {
    const { ctx, calls } = fixture(list(record(skillName, expectedDescription)).replace(/\n/gu, newline), skillName)
    assert.deepEqual(await readGeminiSkills(ctx, cwd, expectedDescription, true), {
      level: 'skill-discovery', name: skillName, present: true, description: expectedDescription,
    })
    assert.deepEqual(calls, [[['skills', 'list'], cwd]])
  }
})

test('accepts explicit empty discovery or unrelated records as fixture absence', async () => {
  for (const stdout of ['No skills discovered.\n', 'No skills discovered.\r\n', list(record(`${name}-other`))]) {
    const { ctx, calls } = fixture(stdout)
    assert.deepEqual(await readGeminiSkills(ctx, '/isolated/neutral', description, false), {
      level: 'skill-discovery', name, present: false,
    })
    assert.deepEqual(calls, [[['skills', 'list'], '/isolated/neutral']])
  }
})

// Test Value Gate: another Skill's matching description must not conceal a
// stale or missing fixture description after refresh.
test('binds the exact description and name to the fixture record', async () => {
  for (const stdout of [
    list(record(name, 'old revision'), record('other-skill')),
    list(record('other-skill'), record(name, 'old revision')),
    list(record(name).replace(`  Description: ${description}\n`, ''), record('other-skill')),
    list(record(`${name}-other`)),
  ]) {
    const { ctx } = fixture(stdout)
    await assert.rejects(readGeminiSkills(ctx, '/isolated/project', description, true), { code: 'ERR_ASSERTION' })
  }
  const { ctx } = fixture(list(record('awXqualfixture')), 'aw.qual+[fixture]')
  await assert.rejects(readGeminiSkills(ctx, '/isolated/project', description, true), { code: 'ERR_ASSERTION' })
})

// Test Value Gate: disabled, unknown and duplicate fixture records must not
// prove enabled discovery or successful scope isolation.
test('rejects disabled, unknown and duplicate fixtures in both observation modes', async () => {
  for (const present of [true, false]) {
    for (const stdout of [
      list(record(name, description, 'Disabled')),
      list(record(name, description, 'Unknown')),
      list(record(), record()),
      list(record(), record(name, description, 'Disabled')),
    ]) {
      const { ctx } = fixture(stdout)
      await assert.rejects(readGeminiSkills(ctx, '/isolated/neutral', description, present), { code: 'ERR_ASSERTION' })
    }
  }
})

test('does not accept a discovered fixture when absence is required', async () => {
  const { ctx } = fixture(list(record()))
  await assert.rejects(readGeminiSkills(ctx, '/isolated/neutral', description, false), { code: 'ERR_ASSERTION' })
})

// Test Value Gate: failed or unknown stdout must never prove absence, even
// when stderr happens to contain a valid list.
test('rejects errors and unknown list shapes in both observation modes', async () => {
  for (const present of [true, false]) {
    for (const stdout of [
      '', undefined, 'Error: skills unavailable\n', record(),
      'Discovered Agent Skills:\n\n',
      'Discovered Agent Skills:\n\nError: skills unavailable\n',
      `No skills discovered.\n${list(record())}`,
      `${list(record())}Error: skills unavailable\n`,
      list(record().replace(' [Enabled]', '')),
    ]) {
      const { ctx } = fixture(stdout)
      ctx.command = async () => ({ stdout, stderr: list(record()) })
      await assert.rejects(readGeminiSkills(ctx, '/isolated/project', description, present), { code: 'ERR_ASSERTION' })
    }
  }
})

test('propagates the original command error without retry in both observation modes', async () => {
  for (const present of [true, false]) {
    const original = new Error('command failed')
    const calls = []
    const ctx = {
      skillName: name,
      async command(...args) { calls.push(args); throw original },
    }
    await assert.rejects(readGeminiSkills(ctx, '/isolated/project', description, present), error => error === original)
    assert.deepEqual(calls, [[['skills', 'list'], '/isolated/project']])
  }
})
