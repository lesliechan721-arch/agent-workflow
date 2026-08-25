import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Digest } from './types.js'

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export async function computeCaseCorpusDigest(casePaths: string[]): Promise<Digest> {
  const documents = await Promise.all(
    casePaths.map(async (filePath) => canonicalJson(JSON.parse(await readFile(filePath, 'utf8')))),
  )
  documents.sort()
  return `sha256:${createHash('sha256').update(documents.join('\n')).digest('hex')}`
}
