import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type {
  Digest,
  SchemaName,
} from './types.js'

export async function getSchema(name: SchemaName): Promise<Record<string, unknown>> {
  return JSON.parse((await readSchema(name)).toString('utf8')) as Record<string, unknown>
}

export async function getSchemaDigest(name: SchemaName): Promise<Digest> {
  try {
    const digests = JSON.parse(
      await readFile(new URL('./schemas/digests.json', import.meta.url), 'utf8'),
    ) as Record<SchemaName, Digest>
    return digests[name]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const schema = JSON.parse((await readSchema(name)).toString('utf8'))
  return `sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}`
}

async function readSchema(name: SchemaName): Promise<Buffer> {
  const embedded = new URL(`./schemas/${name}.schema.json`, import.meta.url)
  try {
    return await readFile(embedded)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url))
  }
}
