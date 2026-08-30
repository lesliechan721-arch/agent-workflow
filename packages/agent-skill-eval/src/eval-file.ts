import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { sha256 } from './common.js'
import type { Digest } from './types.js'

export interface EvalContractFile {
  path: string
  raw: string
  digest: Digest
  value: unknown
}

export async function readEvalContractFile(filePath: string, label: string): Promise<EvalContractFile> {
  const requestedPath = path.resolve(filePath)
  const info = await lstat(requestedPath)
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`${label} must be a regular non-symlink file`)
  const raw = await readFile(requestedPath, 'utf8')
  return { path: requestedPath, raw, digest: sha256(raw), value: JSON.parse(raw) as unknown }
}

export async function computeEvalFileDigest(filePath: string): Promise<Digest> {
  return (await readEvalContractFile(filePath, 'Eval contract file')).digest
}
