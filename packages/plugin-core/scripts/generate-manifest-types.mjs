import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { compile } from 'json-schema-to-typescript'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = path.join(packageRoot, 'schemas', 'plugin-manifest-v3.json')
const outputPath = path.join(packageRoot, 'src', 'generated', 'plugin-manifest-v3.ts')
const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'))
// Runtime validation keeps the 1..4 join limit; the public TypeScript contract uses an array.
const typeSchema = structuredClone(schema)
delete typeSchema.$defs.configJoinSummary.properties.parts.minItems
delete typeSchema.$defs.configJoinSummary.properties.parts.maxItems
const generated = (await compile(typeSchema, 'PluginManifestSourceV3', {
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
    throw new Error('Generated PluginManifestSourceV3 is stale. Run `pnpm --filter @lesliechan721/aw-plugin-core generate`.')
  }
} else {
  await fs.writeFile(outputPath, generated)
}
