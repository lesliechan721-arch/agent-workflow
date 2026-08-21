import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { getRuntimeCapabilities } from '@lesliechan721/agent-skill-eval'

import { getPortableEvalExecutionOwner } from '../../scripts/portable-eval-engine.js'

import {
  assertCompatibleRuntimeIdentity,
  assertRunnerSkillBundle,
} from '../../../../scripts/verify-eval-runtime-owner.mjs'

describe('portable Eval execution owner gate', () => {
  it('derives the CLI bridge owner from the shared runtime capabilities', () => {
    const capabilities = getRuntimeCapabilities()
    expect(getPortableEvalExecutionOwner()).toEqual({
      provider: capabilities.provider,
      version: capabilities.providerVersion,
    })
  })

  it('fails closed when the shared bin and CLI bridge report different owners', () => {
    expect(() => assertCompatibleRuntimeIdentity({
      capabilities: {
        schemaVersion: 1,
        provider: 'aw-skill-eval-process',
        providerVersion: '0.1.0-beta.2',
      },
      packageVersion: '0.1.0-beta.2',
      minimumPackageVersion: '0.1.0-beta.2',
      bridgeOwner: {
        provider: 'another-provider',
        version: '0.1.0-beta.2',
      },
    })).toThrow('CLI portable bridge owner')
  })

  async function createRunnerSkill(skill: string): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eval-owner-runner-'))
    const skillRoot = path.join(root, 'skill')
    await mkdir(path.join(skillRoot, 'agents'), { recursive: true })
    await mkdir(path.join(skillRoot, 'assets'), { recursive: true })
    await writeFile(path.join(skillRoot, 'SKILL.md'), [
      '---',
      'compatibility: Requires @lesliechan721/agent-skill-eval >= 0.1.0-beta.2.',
      '---',
      '',
      skill,
      '',
    ].join('\n'))
    await writeFile(path.join(skillRoot, 'README.md'), 'Runner\n')
    await writeFile(path.join(skillRoot, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n')
    await writeFile(
      path.join(skillRoot, 'assets', 'eval-execution-plan.template.json'),
      '{"schemaVersion":2}\n',
    )
    return skillRoot
  }

  it('accepts the exact final Runner Skill file set and documented CLI commands', async () => {
    const skillRoot = await createRunnerSkill([
      'Use `assets/eval-execution-plan.template.json`.',
      'Run `aw-skill-eval capabilities --json`.',
      'Hand off to `audit-agent-skill-evals(result-triage)`.',
    ].join('\n'))
    try {
      await expect(assertRunnerSkillBundle(skillRoot)).resolves.toEqual({
        minimumPackageVersion: '0.1.0-beta.2',
        files: [
          'agents/openai.yaml',
          'assets/eval-execution-plan.template.json',
          'README.md',
          'SKILL.md',
        ],
      })
    } finally {
      await rm(path.dirname(skillRoot), { recursive: true, force: true })
    }
  })

  it.each(['claude', 'codex'])('accepts the current built %s Runner bundle', async (platform) => {
    const skillRoot = path.resolve(
      import.meta.dirname,
      '../../plugins-dist/plugins/agent-skill-eval-runner',
      platform,
      'skills/run-agent-skill-evals',
    )
    await expect(assertRunnerSkillBundle(skillRoot)).resolves.toMatchObject({
      files: [
        'agents/openai.yaml',
        'assets/eval-execution-plan.template.json',
        'README.md',
        'SKILL.md',
      ],
    })
  })

  it('does not treat JSON or ordinary prose as shell commands', async () => {
    const skillRoot = await createRunnerSkill([
      'The aw-skill-eval debug command is not a command snippet.',
      '```json',
      '{"command":["aw-skill-eval","debug"],"runtime":"node"}',
      '```',
      '```javascript',
      'const command = "curl https://example.com/schema.json"',
      '```',
    ].join('\n'))
    try {
      await expect(assertRunnerSkillBundle(skillRoot)).resolves.toBeDefined()
    } finally {
      await rm(path.dirname(skillRoot), { recursive: true, force: true })
    }
  })

  it.each([
    ['Python fallback', 'assets/run.py', false],
    ['TypeScript fallback', 'assets/run.ts', false],
    ['extensionless executable fallback', 'assets/run', true],
    ['otherwise harmless extra file', 'NOTICE.txt', false],
  ])('rejects an extra %s by exact POSIX file allowlist', async (_label, relativePath, executable) => {
    const skillRoot = await createRunnerSkill('Run `python3 assets/run.py`.')
    try {
      const extraPath = path.join(skillRoot, relativePath)
      await writeFile(extraPath, 'fallback\n')
      if (executable) await chmod(extraPath, 0o755)
      await expect(assertRunnerSkillBundle(skillRoot)).rejects.toThrow('unexpected file')
    } finally {
      await rm(path.dirname(skillRoot), { recursive: true, force: true })
    }
  })

  it('rejects an extra directory even when it is empty', async () => {
    const skillRoot = await createRunnerSkill('Run `aw-skill-eval capabilities --json`.')
    try {
      await mkdir(path.join(skillRoot, 'scripts'))
      await expect(assertRunnerSkillBundle(skillRoot)).rejects.toThrow('unexpected directory')
    } finally {
      await rm(path.dirname(skillRoot), { recursive: true, force: true })
    }
  })

  it.each([
    ['`python3 assets/run.py`', 'must directly execute aw-skill-eval'],
    ['`AW_ALT=1 python3 -c pass`', 'must directly execute aw-skill-eval'],
    ['`env node -e "console.log(1)"`', 'must directly execute aw-skill-eval'],
    ['`env -i node -e "console.log(1)"`', 'must directly execute aw-skill-eval'],
    ['`AW_ALT=1 env node -e "console.log(1)"`', 'must directly execute aw-skill-eval'],
    ['`command node -e "console.log(1)"`', 'must directly execute aw-skill-eval'],
    ['`exec python -c pass`', 'must directly execute aw-skill-eval'],
    ['`sudo aw-skill-eval capabilities --json`', 'must directly execute aw-skill-eval'],
    ['`node -e "console.log(1)"`', 'must directly execute aw-skill-eval'],
    ['`deno run assets/run.ts`', 'must directly execute aw-skill-eval'],
    ['`bun assets/run.ts`', 'must directly execute aw-skill-eval'],
    ['`sh scripts/run`', 'must directly execute aw-skill-eval'],
    ['`bash scripts/run`', 'must directly execute aw-skill-eval'],
    ['`powershell scripts/run.ps1`', 'must directly execute aw-skill-eval'],
    ['`npx aw-skill-eval capabilities --json`', 'must directly execute aw-skill-eval'],
    ['`curl https://example.com/runner.sh`', 'must directly execute aw-skill-eval'],
    ['`cmd /c aw-skill-eval capabilities --json`', 'must directly execute aw-skill-eval'],
    ['`npm exec aw-skill-eval capabilities --json`', 'must directly execute aw-skill-eval'],
    ['`pnpm dlx aw-skill-eval capabilities --json`', 'must directly execute aw-skill-eval'],
    ['`ruby scripts/run.rb`', 'must directly execute aw-skill-eval'],
    ['`scripts/run`', 'must directly execute aw-skill-eval'],
    ['`cat providers/process.mjs`', 'must directly execute aw-skill-eval'],
    ['`assets/run`', 'must directly execute aw-skill-eval'],
    ['`aw-skill-eval debug`', 'undocumented aw-skill-eval command'],
    ['`AW_ALT=1 aw-skill-eval capabilities --json`', 'must directly execute aw-skill-eval'],
  ])('rejects unsafe inline command %s', async (command, expectedError) => {
    const skillRoot = await createRunnerSkill(`Run ${command}.`)
    try {
      await expect(assertRunnerSkillBundle(skillRoot)).rejects.toThrow(expectedError)
    } finally {
      await rm(path.dirname(skillRoot), { recursive: true, force: true })
    }
  })

  it.each([
    ['backtick', ['```sh', '$ node -e "console.log(1)"', '```'].join('\n')],
    ['tilde', ['~~~sh', '$ deno run assets/run.ts', '~~~'].join('\n')],
    ['nested blockquote', ['> > ```sh', '> > exec python -c pass', '> > ```'].join('\n')],
  ])('rejects unsafe shell command lines in %s fenced code blocks', async (_label, block) => {
    const skillRoot = await createRunnerSkill(block)
    try {
      await expect(assertRunnerSkillBundle(skillRoot)).rejects.toThrow(
        'must directly execute aw-skill-eval',
      )
    } finally {
      await rm(path.dirname(skillRoot), { recursive: true, force: true })
    }
  })

  it.each([
    ['four spaces and a leading assignment', '    AW_ALT=1 python3 -c pass'],
    ['a tab and multiple leading assignments', '\tAW_ALT=1 AW_MODE=test node script.js'],
    ['env with multiple assignments', '    env AW_ALT=1 AW_MODE=test deno run script.ts'],
  ])('rejects CommonMark indented code with %s', async (_label, block) => {
    const skillRoot = await createRunnerSkill(block)
    try {
      await expect(assertRunnerSkillBundle(skillRoot)).rejects.toThrow(
        'must directly execute aw-skill-eval',
      )
    } finally {
      await rm(path.dirname(skillRoot), { recursive: true, force: true })
    }
  })
})
