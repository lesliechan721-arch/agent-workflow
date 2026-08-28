import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { compile } from 'json-schema-to-typescript'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = path.join(packageRoot, 'schemas', 'plugin-manifest-v2.json')
const outputPath = path.join(packageRoot, 'src', 'generated', 'plugin-manifest-v2.ts')
const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'))
const generated = await compile(schema, 'PluginManifestSourceV2', {
  bannerComment: '/* This file is generated. Run `pnpm generate` in packages/plugin-core to update it. */',
  declareExternallyReferenced: true,
  enableConstEnums: false,
  format: false,
  strictIndexSignatures: true,
  style: {
    singleQuote: true,
    semi: false,
    tabWidth: 2,
    trailingComma: 'all',
  },
  unreachableDefinitions: true,
})

if (process.argv.includes('--check')) {
  const current = await fs.readFile(outputPath, 'utf8').catch(() => '')
  if (current !== generated) {
    throw new Error('Generated PluginManifestSourceV2 is stale. Run `pnpm --filter @lesliechan721/aw-plugin-core generate`.')
  }
} else {
  await fs.writeFile(outputPath, generated)
}
