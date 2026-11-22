import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { compile } from 'json-schema-to-typescript'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = path.join(packageRoot, 'schemas', 'plugin-manifest-v4.json')
const outputPath = path.join(packageRoot, 'src', 'generated', 'plugin-manifest-v4.ts')
const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'))
// Runtime validation checks cardinality; public TypeScript collections use arrays.
const typeSchema = structuredClone(schema)
function normalizeArrayTypes(value) {
  if (!value || typeof value !== 'object') return
  if (value.type === 'array') { delete value.minItems; delete value.maxItems }
  for (const child of Object.values(value)) normalizeArrayTypes(child)
}
normalizeArrayTypes(typeSchema)
const generated = (await compile(typeSchema, 'PluginManifestSourceV4', {
  bannerComment: '/* This file is generated. Run `pnpm generate` in packages/plugin-core to update it. */',
  declareExternallyReferenced: true,
  enableConstEnums: false,
  format: false,
  style: {
    singleQuote: true,
    semi: false,
    tabWidth: 2,
    trailingComma: 'all',
  },
  unreachableDefinitions: true,
})).replace(/[\t ]+$/gmu, '')

if (process.argv.includes('--check')) {
  const current = await fs.readFile(outputPath, 'utf8').catch(() => '')
  if (current !== generated) {
    throw new Error('Generated PluginManifestSourceV4 is stale. Run `pnpm --filter @lesliechan721/aw-plugin-core generate`.')
  }
} else {
  await fs.writeFile(outputPath, generated)
}
