import os from 'node:os'
import path from 'node:path'

import {
  initializeCatalogWorkspace,
  type PluginManifestSource,
} from '@lesliechan721/aw-plugin-core'
import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveReviewSelection } from '../../src/review/review-selection.js'
import { normalizeReviewProfileConfig } from '../../src/review/review-profile.js'
import {
  createAwSourceBindingWorkspaceValidationContext,
  readAwSourceBinding,
  resolveWorkspaceBindingSource,
  validateAwSourceBindingForWorkspace,
  writeAwSourceBinding,
} from '../../src/review/source-binding.js'

const roots: string[] = []

async function tempRoot(label: string): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), label)))
  roots.push(root)
  return root
}

function manifest(name: string): PluginManifestSource {
  return {
    schemaVersion: 3,
    name,
    version: '0.1.0',
    description: `${name} binding fixture.`,
    skills: './skills',
    marketplace: {
      category: 'test',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: ['CODEX'],
      },
    },
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})

describe('Review source binding', () => {
  it('keeps complete array overrides with stable object order and rejects nested items', () => {
    expect(normalizeReviewProfileConfig({ demo: {
      models: [{ weight: 1, 'model-name': 'one' }, { weight: 2, 'model-name': 'two' }],
      labels: [],
    } })).toEqual({ demo: {
      labels: [],
      models: [{ 'model-name': 'one', weight: 1 }, { 'model-name': 'two', weight: 2 }],
    } })
    expect(() => normalizeReviewProfileConfig({ demo: { labels: [['nested']] } })).toThrow('invalid array')
    expect(() => normalizeReviewProfileConfig({ demo: { labels: ['one', 2] } })).toThrow('invalid array')
  })

  it('writes, parses, and verifies a current Review Skill binding', async () => {
    const workspaceRoot = await tempRoot('aw-review-binding-workspace-')
    const outputRoot = await tempRoot('aw-review-binding-output-')
    await initializeCatalogWorkspace({ workspaceRoot })
    const pluginRoot = path.join(workspaceRoot, 'plugins', 'binding-plugin')
    await Promise.all([
      fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest('binding-plugin')),
      fs.outputFile(
        path.join(pluginRoot, 'skills', 'bound-skill', 'SKILL.md'),
        '---\nname: bound-skill\ndescription: Source fixture.\n---\n\n# Source\n',
      ),
      fs.outputFile(
        path.join(outputRoot, 'skills', 'bound-skill', 'SKILL.md'),
        '---\nname: bound-skill\ndescription: Final fixture.\n---\n\n# Final\n',
      ),
    ])
    const selection = await resolveReviewSelection({
      cwd: workspaceRoot,
      target: 'binding-plugin',
      skills: ['bound-skill'],
      platform: 'codex',
      scope: 'user',
    })
    const written = await writeAwSourceBinding({
      rootDir: outputRoot,
      source: await resolveWorkspaceBindingSource(selection.workspace),
      subject: { plugin: 'binding-plugin', skill: 'bound-skill' },
      profile: selection.profiles[0]!.profile,
      artifacts: [{
        kind: 'review-skill',
        plugin: 'binding-plugin',
        skill: 'bound-skill',
        path: 'skills/bound-skill',
      }],
    })

    await expect(readAwSourceBinding(written.bindingPath)).resolves.toMatchObject({
      schemaVersion: 2,
      profile: {
        kind: 'review',
        id: 'codex-user',
        platform: 'codex',
        scope: 'user',
        config: {},
      },
      artifacts: [{
        kind: 'review-skill', plugin: 'binding-plugin', skill: 'bound-skill',
      }],
    })
    const context = await createAwSourceBindingWorkspaceValidationContext(workspaceRoot)
    await expect(validateAwSourceBindingForWorkspace({
      bindingPath: written.bindingPath,
      context,
      expectedSubject: { plugin: 'binding-plugin', skill: 'bound-skill' },
    })).resolves.toMatchObject({
      state: 'verified',
      outputs: [{ kind: 'review-skill', plugin: 'binding-plugin', skill: 'bound-skill' }],
      issues: [],
    })

    await fs.appendFile(path.join(pluginRoot, 'skills', 'bound-skill', 'SKILL.md'), '\nChanged.\n')
    const changedContext = await createAwSourceBindingWorkspaceValidationContext(workspaceRoot)
    const changed = await validateAwSourceBindingForWorkspace({
      bindingPath: written.bindingPath,
      context: changedContext,
      expectedSubject: { plugin: 'binding-plugin', skill: 'bound-skill' },
    })
    expect(changed.state).toBe('drifted')
    expect(changed.issues).toContainEqual(expect.objectContaining({ code: 'sourceBindingSourceDrift' }))
  })

  it('rejects Review artifact ownership outside the bound plugin', async () => {
    const outputRoot = await tempRoot('aw-review-binding-owner-')
    await fs.outputFile(
      path.join(outputRoot, 'skills', 'owned', 'SKILL.md'),
      '---\nname: owned\ndescription: Owned fixture.\n---\n\n# Owned\n',
    )
    const digest = `sha256:${'a'.repeat(64)}`
    await expect(writeAwSourceBinding({
      rootDir: outputRoot,
      source: { kind: 'workspace', workspaceIdentity: 'fixture', sourceIdentity: digest },
      subject: { plugin: 'owner' },
      profile: {
        kind: 'review',
        id: 'codex-user',
        platform: 'codex',
        scope: 'user',
        inputDigest: digest,
        config: {},
      },
      artifacts: [{
        kind: 'review-skill', plugin: 'foreign', skill: 'owned', path: 'skills/owned',
      }],
    })).rejects.toThrow('artifacts do not match the Review profile')
    await expect(fs.pathExists(path.join(outputRoot, 'aw-source-binding.json'))).resolves.toBe(false)
  })
})
