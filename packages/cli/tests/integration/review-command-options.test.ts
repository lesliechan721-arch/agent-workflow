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
    ['unknown option', ['dev', 'review', 'inspect', 'target', '--unknown', '--json']],
    ['repeated single-value option', [
      'dev', 'review', 'inspect', 'target', '--scope', 'user', '--scope', 'project', '--json',
    ]],
    ['missing option value', ['dev', 'review', 'inspect', 'target', '--json', '--scope']],
    ['extra positional argument', ['dev', 'review', 'inspect', 'target', 'extra', '--json']],
    ...['both', 'agent-skills', 'claude-code', 'gemini'].map((platform) => [
      `invalid platform ${platform}`, ['dev', 'review', 'inspect', 'target', '--platform', platform, '--json'],
    ] as [string, string[]]),
  ])('returns one inspect JSON argument failure for %s', async (_label, argv) => {
    const output = capture()

    const exitCode = await runCli(argv, { io: output.io })

    expect(exitCode).toBe(2)
    expect(JSON.parse(output.stdout())).toEqual(expect.objectContaining({
      schemaVersion: 1,
      status: 'failed',
      command: 'dev.review.inspect',
      diagnostics: [expect.objectContaining({ code: _label.startsWith('invalid platform') || _label === 'repeated single-value option' ? 'invalidOptionValue' : 'invalidArguments' })],
      data: {}
    }))
  })

  it.each([
    ['unknown option', [
      'dev', 'review', 'prepare', 'target', '--platform', 'codex', '--scope', 'user',
      '--out', 'prepared', '--unknown', '--json',
    ]],
    ['repeated single-value option', [
      'dev', 'review', 'prepare', 'target', '--platform', 'codex', '--platform', 'claude',
      '--scope', 'user', '--out', 'prepared', '--json',
    ]],
    ['missing required option', [
      'dev', 'review', 'prepare', 'target', '--platform', 'codex', '--out', 'prepared', '--json',
    ]],
    ['extra positional argument', [
      'dev', 'review', 'prepare', 'target', 'extra', '--platform', 'codex', '--scope', 'user',
      '--out', 'prepared', '--json',
    ]],
    ...['both', 'agent-skills', 'claude-code', 'gemini'].map((platform) => [
      `invalid platform ${platform}`, ['dev', 'review', 'prepare', 'target', '--platform', platform, '--scope', 'user', '--out', 'prepared', '--json'],
    ] as [string, string[]]),
    ['missing platform', ['dev', 'review', 'prepare', 'target', '--scope', 'user', '--out', 'prepared', '--json']],
  ])('returns one prepare JSON argument failure for %s', async (_label, argv) => {
    const output = capture()

    const exitCode = await runCli(argv, { io: output.io })

    expect(exitCode).toBe(2)
    expect(JSON.parse(output.stdout())).toEqual(expect.objectContaining({
      schemaVersion: 1,
      status: 'failed',
      command: 'dev.review.prepare',
      diagnostics: [expect.objectContaining({ code: _label.startsWith('invalid platform') || _label === 'repeated single-value option' ? 'invalidOptionValue' : 'invalidArguments' })],
      data: {}
    }))
  })

  it('renders a plain-text preparation failure without JSON framing', async () => {
    const output = capture()

    const exitCode = await runCli([
      'dev', 'review', 'prepare', 'missing-target',
      '--platform', 'codex', '--scope', 'user', '--out', 'prepared',
    ], { io: output.io })

    expect(exitCode).toBe(3)
    expect(output.stdout()).toContain('BLOCKED')
    expect(output.stderr()).toContain('catalogWorkspaceMissing:')
    expect(() => JSON.parse(output.stdout())).toThrow()
  })
})
