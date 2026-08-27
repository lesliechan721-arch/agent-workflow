import fs from 'node:fs/promises'
import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CATALOG_WORKSPACE_VERSION,
} from '@lesliechan721/aw-plugin-core'
import {
  getPluginAuthoringCapabilities,
  getPluginAuthoringCapabilitySurface,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
} from '@lesliechan721/aw-plugin-core/manifest'

const require = createRequire(import.meta.url)

describe('public package exports', () => {
  it('exposes the manifest runtime and published v1 schema subpaths', async () => {
    expect(DEFAULT_CATALOG_WORKSPACE_VERSION).toBe('0.1.0')
    expect(PLUGIN_MANIFEST_SCHEMA_VERSION).toBe(1)
    expect(getPluginAuthoringCapabilities().schemaVersion).toBe(1)
    expect(getPluginAuthoringCapabilitySurface('manifest').surface).toBe('manifest')
    const schemaPath = require.resolve(
      '@lesliechan721/aw-plugin-core/schemas/plugin-manifest-v1.json',
    )
    const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'))
    expect(schema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'PluginManifestSourceV1',
    })
  })
})
