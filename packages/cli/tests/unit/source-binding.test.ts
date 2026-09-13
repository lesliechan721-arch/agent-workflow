import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalJson,
  computeEvalProviderDigest,
  type SelectedCasesDocument,
} from '@lesliechan721/agent-skill-eval'

import {
  readAwSourceBinding,
  resolveEvalProfileBindingInput,
  resolveEvalSourceBindingInput,
  validateAwSourceBindingForWorkspace,
  writeAwSourceBinding,
  type AwSourceBindingWorkspaceValidationContext,
} from '../../src/review/source-binding.js'
import type { PluginMeta } from '../../src/types.js'

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
  it('binds merged effective config for the profile scope and shared native user scope', () => {
    const plugin = {
      rootDir: '/fixture',
      manifestPath: '/fixture/.agents-plugin/plugin.json',
      manifest: {
        name: 'fixture',
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
        },
        config: {
          fields: {
            common: { type: 'string', required: true },
            selected: { type: 'string', required: true },
            settings: {
              type: 'object',
              properties: { first: { type: 'string' }, second: { type: 'string' } },
              additionalProperties: false,
            },
          },
        },
        artifacts: {
          targets: [{
            id: 'native',
            platform: 'codex',
            scopes: ['project', 'user'],
            target: 'codex.skill',
            states: ['present'],
            refreshKeys: ['common'],
            skillKey: 'native',
            delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
          }],
        },
      },
    } as PluginMeta
    const projectOnlyPlugin = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        name: 'project-only',
        config: { fields: { projectOnly: { type: 'string', required: true } } },
        artifacts: {
          targets: [{
            id: 'direct', platform: 'codex', scopes: ['project', 'user'],
            target: 'codex.skill', states: ['present'], refreshKeys: ['projectOnly'],
            skillKey: 'direct', delivery: { mode: 'aw-extension' },
          }],
        },
      },
    } as PluginMeta
    const userOnlyNativePlugin = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        name: 'user-only-native',
        config: { fields: { projectValue: { type: 'string', required: true } } },
        artifacts: {
          targets: [{
            id: 'user-native', platform: 'codex', scopes: ['user'],
            target: 'codex.skill', states: ['present'], refreshKeys: [],
            skillKey: 'user-native',
            delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
          }],
        },
      },
    } as PluginMeta
    const base = {
      id: 'selected',
      scope: 'project' as const,
      plugins: [{
        name: 'fixture',
        config: { common: 'base', selected: 'base', settings: { first: 'base', second: 'base' } },
      }, { name: 'project-only', config: {} }, { name: 'user-only-native', config: {} }],
    }
    const first = resolveEvalProfileBindingInput({
      ...base,
      configByScope: {
        project: [
          { name: 'fixture', config: { selected: 'project', settings: { first: 'project' } } },
          { name: 'project-only', config: { projectOnly: 'project' } },
          { name: 'user-only-native', config: { projectValue: 'project' } },
        ],
        user: [{ name: 'fixture', config: { selected: 'user' } }],
      },
    }, [plugin, projectOnlyPlugin, userOnlyNativePlugin])
    expect(first.materializationProfile.plugins).toEqual([
      {
        name: 'fixture',
        configByScope: {
          project: { common: 'base', selected: 'project', settings: { first: 'project' } },
          user: { common: 'base', selected: 'user', settings: { first: 'base', second: 'base' } },
        },
      },
      { name: 'project-only', configByScope: { project: { projectOnly: 'project' } } },
      { name: 'user-only-native', configByScope: { project: { projectValue: 'project' } } },
    ])
    const changed = resolveEvalProfileBindingInput({
      ...base,
      configByScope: {
        project: [
          { name: 'fixture', config: { selected: 'project', settings: { first: 'project' } } },
          { name: 'project-only', config: { projectOnly: 'project' } },
          { name: 'user-only-native', config: { projectValue: 'project' } },
        ],
        user: [{ name: 'fixture', config: { selected: 'changed-user' } }],
      },
    }, [plugin, projectOnlyPlugin, userOnlyNativePlugin])
    expect(changed.profile.inputDigest).not.toBe(first.profile.inputDigest)
  })

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

  it('rejects a v1 receipt and tells the user to materialize it again', async () => {
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
    expect(receipt.schemaVersion).toBe(2)
    receipt.schemaVersion = 1
    const unsigned = { ...receipt }
    delete unsigned.finalDigest
    receipt.finalDigest = `sha256:${crypto.createHash('sha256').update(canonicalJson(unsigned)).digest('hex')}`
    await fs.writeJson(written.bindingPath, receipt)

    await expect(readAwSourceBinding(written.bindingPath)).rejects.toThrow(
      'schema version 1 is unsupported. Run "aw skill eval prepare" or "aw skill materialize" again.',
    )
    await expect(validateAwSourceBindingForWorkspace({
      bindingPath: written.bindingPath,
      context: unusedContext,
      expectedSubject: { plugin: 'fixture' },
    })).resolves.toMatchObject({
      state: 'invalid',
      binding: null,
      issues: [{
        code: 'sourceBindingInvalid',
        message: 'AW source binding schema version 1 is unsupported. '
          + 'Run "aw skill eval prepare" or "aw skill materialize" again.',
      }],
    })
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
