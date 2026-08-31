import { readFile } from 'node:fs/promises'
import type {
  Digest,
  SchemaName,
} from './types.js'

export async function getSchema(name: SchemaName): Promise<Record<string, unknown>> {
  const source = new URL(`./schemas/${name}.schema.json`, import.meta.url)
  return JSON.parse(await readFile(source, 'utf8')) as Record<string, unknown>
}

export async function getSchemaDigest(name: SchemaName): Promise<Digest> {
  const digests = JSON.parse(
    await readFile(new URL('./schemas/digests.json', import.meta.url), 'utf8'),
  ) as Record<SchemaName, Digest>
  return digests[name]
}
