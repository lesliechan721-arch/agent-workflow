import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'
import { computeEvalProviderDigest, type SelectedCasesDocument } from '@lesliechan721/agent-skill-eval'

import {
  resolveEvalSourceBindingInput,
  validateAwSourceBindingForWorkspace,
  writeAwSourceBinding,
  type AwSourceBindingWorkspaceValidationContext,
} from '../../src/review/source-binding.js'

const roots: string[] = []
const digest = `sha256:${'a'.repeat(64)}`

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-source-binding-'))
  roots.push(root)
  return root
}

const unusedContext = {
  workspace: {},
  source: { kind: 'workspace', workspaceIdentity: 'unused', sourceIdentity: digest },
} as AwSourceBindingWorkspaceValidationContext

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})

describe('AW source binding', () => {
  it('reports a missing legacy receipt as incomplete', async () => {
    const root = await tempRoot()
    await expect(validateAwSourceBindingForWorkspace({
      bindingPath: path.join(root, 'aw-source-binding.json'),
      context: unusedContext,
      expectedSubject: { plugin: 'fixture' },
    })).resolves.toEqual({
      state: 'incomplete',
      binding: null,
      outputs: [],
      issues: [{ code: 'sourceBindingMissing', message: 'AW source binding receipt is missing.' }],
    })
  })

  it('rejects artifact paths outside the materialization root', async () => {
    const root = await tempRoot()
    await expect(writeAwSourceBinding({
      rootDir: root,
      source: { kind: 'workspace', workspaceIdentity: 'fixture', sourceIdentity: digest },
      subject: { plugin: 'fixture' },
      profile: {
        kind: 'portable', id: 'agent-skills-project', scope: 'project', inputDigest: digest,
      },
      artifacts: [{ kind: 'portable-skill', plugin: 'fixture', skill: 'fixture', path: '../outside' }],
    })).rejects.toThrow('safe relative POSIX path')
    await expect(fs.pathExists(path.join(root, 'aw-source-binding.json'))).resolves.toBe(false)
  })

  it('does not accept editable approval fields in a receipt', async () => {
    const root = await tempRoot()
    await fs.outputFile(
      path.join(root, 'skills', 'fixture', 'SKILL.md'),
      '---\nname: fixture\ndescription: fixture\n---\nBody.\n',
    )
    const written = await writeAwSourceBinding({
      rootDir: root,
      source: { kind: 'workspace', workspaceIdentity: 'fixture', sourceIdentity: digest },
      subject: { plugin: 'fixture' },
      profile: {
        kind: 'portable', id: 'agent-skills-project', scope: 'project', inputDigest: digest,
      },
      artifacts: [{ kind: 'portable-skill', plugin: 'fixture', skill: 'fixture', path: 'skills/fixture' }],
    })
    const receipt = await fs.readJson(written.bindingPath)
    receipt.approved = true
    await fs.writeJson(written.bindingPath, receipt)
    await expect(validateAwSourceBindingForWorkspace({
      bindingPath: written.bindingPath,
      context: unusedContext,
      expectedSubject: { plugin: 'fixture' },
    })).resolves.toMatchObject({
      state: 'invalid',
      binding: null,
      issues: [{ code: 'sourceBindingInvalid' }],
    })
  })

  it('binds pathPrepend fixture bytes without storing fixture details', async () => {
    const root = await tempRoot()
    const evalRoot = path.join(root, 'plugins', 'fixture', 'skills', 'fixture', 'evals')
    const manifestPath = path.join(evalRoot, 'manifest.json')
    const fixturePath = path.join(evalRoot, 'fixtures', 'bin', 'fixture-tool')
    const cases: SelectedCasesDocument = {
      version: 1,
      suite: {
        kind: 'conversation',
        unitUnderTest: 'fixture',
        runtime: { pathPrepend: ['fixtures/bin'] },
      },
      cases: [{
        id: 'selected',
        split: 'validation',
        tags: [],
        prompt: 'Run the fixture.',
        assertions: ['Uses the fixture.'],
        input: { pathPrepend: ['fixtures/bin'] },
      }],
    }
    await Promise.all([
      fs.outputJson(manifestPath, { version: 1 }),
      fs.outputJson(path.join(evalRoot, 'cases.json'), cases),
      fs.outputFile(fixturePath, '#!/bin/sh\necho first\n'),
    ])
    await fs.chmod(fixturePath, 0o755)
    const options = {
      workspaceRoot: root,
      evalRoot,
      manifestPath,
      suite: { id: 'suite', kind: 'conversation' as const, cases: 'cases.json' },
      defaults: {},
      cases,
      corpusPaths: ['cases.json'],
      selection: { caseIds: ['selected'] },
      providerDigest: computeEvalProviderDigest('codex-conversation'),
    }
    const first = await resolveEvalSourceBindingInput(options)
    await fs.writeFile(fixturePath, '#!/bin/sh\necho second\n')
    const second = await resolveEvalSourceBindingInput(options)
    expect(second.input.fixturesDigest).not.toBe(first.input.fixturesDigest)
    expect(second.input.selectedCasesDigest).toBe(first.input.selectedCasesDigest)
    expect(Object.keys(first.input)).not.toContain('fixtures')
  })
})
