import os from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertCompatibleRuntimeIdentity,
  assertRunnerSkillBundle,
} from '../../../../scripts/verify-eval-runtime-owner.mjs'

const tempRoots: string[] = []

async function writeRunnerSkill(commands: string | string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-eval-runtime-owner-'))
  tempRoots.push(root)
  const commandLines = Array.isArray(commands) ? commands : [commands]
  await fs.outputFile(path.join(root, 'SKILL.md'), [
    '---',
    'name: run-aw-skill-evals',
    'description: Run one audited Agent Skill Eval plan.',
    '---',
    '',
    'Requires @lesliechan721/agent-skill-eval >= 0.1.0.',
    '',
    '```sh',
    'aw-skill-eval capabilities --json',
    'aw-skill-eval schema print aw-skill-eval-execution-plan',
    'aw-skill-eval schema print eval-run-bundle',
    ...commandLines,
    '```',
    '',
  ].join('\n'))
  await fs.outputFile(path.join(root, 'README.md'), '# Eval Runner\n')
  await fs.outputFile(path.join(root, 'agents', 'openai.yaml'), 'interface:\n  display_name: Eval Runner\n')
  await fs.outputJson(path.join(root, 'aw-plugin-requirements.json'), { schemaVersion: 1 })
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.remove(root)))
})

describe('Eval runtime owner gate', () => {
  it.each(['claude', 'codex'])('accepts the current built %s Runner bundle', async (platform) => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../plugins-dist/plugins/aw-skill-eval-runner',
      platform,
      'skills/run-aw-skill-evals',
    )
    const bundle = await assertRunnerSkillBundle(root)

    expect(new Set(bundle.files)).toEqual(new Set([
      'README.md',
      'SKILL.md',
      'agents/openai.yaml',
      'aw-plugin-requirements.json',
    ]))
    expect(() => assertCompatibleRuntimeIdentity({
      capabilities: {
        schemaVersion: 2,
        provider: 'aw-skill-eval-process',
        providerVersion: '0.1.0',
      },
      packageVersion: '0.1.0',
      minimumPackageVersion: bundle.minimumPackageVersion,
    })).not.toThrow()

    const verifier = await readFile(
      fileURLToPath(new URL('../../../../scripts/verify-eval-runtime-owner.mjs', import.meta.url)),
      'utf8',
    )
    expect(verifier).toContain("['aw-skill-eval-execution-plan', 4]")
    expect(verifier).toContain("['eval-run-bundle', 4]")
  })

  it.each([
    ['prepare help', 'aw skill eval prepare --help'],
    [
      'complete prepare selection',
      'aw skill eval prepare <plugin> <skill> --suite <suite> --profile <profile> --output <new-spec-directory> --json',
    ],
  ])('accepts the documented AW %s command', async (_label, command) => {
    const root = await writeRunnerSkill(command)

    await expect(assertRunnerSkillBundle(root)).resolves.toBeDefined()
  })

  it('rejects any other AW command', async () => {
    const root = await writeRunnerSkill('aw skill eval check <plugin> --skill <skill> --json')

    await expect(assertRunnerSkillBundle(root)).rejects.toThrow(
      'undocumented aw command: aw skill eval check <plugin> --skill <skill> --json',
    )
  })

  it('rejects a Runner model command without its required Audit', async () => {
    const root = await writeRunnerSkill('aw-skill-eval run <plan.json>')

    await expect(assertRunnerSkillBundle(root)).rejects.toThrow(
      'undocumented aw-skill-eval command: aw-skill-eval run <plan.json>',
    )
  })

  it.each([
    ['npm wrapper', 'npx aw-skill-eval capabilities --json'],
    ['Node wrapper', 'node scripts/run-evals.mjs'],
    ['bundled script', './scripts/run-evals'],
  ])('rejects a %s command', async (_label, command) => {
    const root = await writeRunnerSkill(command)

    await expect(assertRunnerSkillBundle(root)).rejects.toThrow(
      'must directly execute aw or aw-skill-eval',
    )
  })

  it('rejects a bundled executable even when SKILL.md does not reference it', async () => {
    const root = await writeRunnerSkill('aw-skill-eval run <plan.json> --audit <audit.json>')
    await fs.outputFile(path.join(root, 'scripts', 'run-evals'), '#!/bin/sh\n')

    await expect(assertRunnerSkillBundle(root)).rejects.toThrow('unexpected directory: scripts')
  })
})
