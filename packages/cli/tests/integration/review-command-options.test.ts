import { describe, expect, it } from 'vitest'

import { runCli } from '../../src/index.js'

function capture() {
  let stdout = ''
  let stderr = ''
  return {
    io: {
      stdout: (text: string) => { stdout += text },
      stderr: (text: string) => { stderr += text },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

describe('review command options', () => {
  it.each([
    ['unknown option', ['review', 'inspect', 'target', '--unknown', '--json']],
    ['repeated single-value option', [
      'review', 'inspect', 'target', '--scope', 'user', '--scope', 'project', '--json',
    ]],
    ['missing option value', ['review', 'inspect', 'target', '--scope', '--json']],
    ['extra positional argument', ['review', 'inspect', 'target', 'extra', '--json']],
    ['invalid choice', ['review', 'inspect', 'target', '--platform', 'both', '--json']],
  ])('returns one inspect JSON argument failure for %s', async (_label, argv) => {
    const output = capture()

    const exitCode = await runCli(argv, { io: output.io })

    expect(exitCode).toBe(2)
    expect(output.stderr()).toBe('')
    expect(JSON.parse(output.stdout())).toEqual(expect.objectContaining({
      schemaVersion: 2,
      command: 'review:inspect',
      view: 'review',
      ok: false,
      target: null,
      skills: [],
      issues: [expect.objectContaining({ code: 'invalidArguments' })],
    }))
  })

  it.each([
    ['unknown option', [
      'review', 'prepare', 'target', '--platform', 'codex', '--scope', 'user',
      '--out', 'prepared', '--unknown', '--json',
    ]],
    ['repeated single-value option', [
      'review', 'prepare', 'target', '--platform', 'codex', '--platform', 'claude',
      '--scope', 'user', '--out', 'prepared', '--json',
    ]],
    ['missing required option', [
      'review', 'prepare', 'target', '--platform', 'codex', '--out', 'prepared', '--json',
    ]],
    ['extra positional argument', [
      'review', 'prepare', 'target', 'extra', '--platform', 'codex', '--scope', 'user',
      '--out', 'prepared', '--json',
    ]],
    ['invalid choice', [
      'review', 'prepare', 'target', '--platform', 'both', '--scope', 'user',
      '--out', 'prepared', '--json',
    ]],
  ])('returns one prepare JSON argument failure for %s', async (_label, argv) => {
    const output = capture()

    const exitCode = await runCli(argv, { io: output.io })

    expect(exitCode).toBe(2)
    expect(output.stderr()).toBe('')
    expect(JSON.parse(output.stdout())).toEqual(expect.objectContaining({
      schemaVersion: 1,
      command: 'review:prepare',
      ok: false,
      target: null,
      sourceBindingPath: null,
      skills: [],
      issues: [expect.objectContaining({ code: 'invalidArguments' })],
    }))
  })

  it('renders a plain-text preparation failure without JSON framing', async () => {
    const output = capture()

    const exitCode = await runCli([
      'review', 'prepare', 'missing-target',
      '--platform', 'codex', '--scope', 'user', '--out', 'prepared',
    ], { io: output.io })

    expect(exitCode).toBe(2)
    expect(output.stderr()).toBe('')
    expect(output.stdout()).toContain('Review preparation: failed')
    expect(output.stdout()).toContain('targetNotFound:')
    expect(() => JSON.parse(output.stdout())).toThrow()
  })
})
