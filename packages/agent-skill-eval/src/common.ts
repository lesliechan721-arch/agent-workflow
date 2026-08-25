import { createHash } from 'node:crypto'
import path from 'node:path'
import { canonicalJson } from './corpus-digest.js'
import type { Digest } from './types.js'

export function sha256(data: string | NodeJS.ArrayBufferView): Digest {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  )
}

export function pathsOverlap(left: string, right: string): boolean {
  return isPathInside(left, right) || isPathInside(right, left)
}

export function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
}

export const stable = canonicalJson

export function toPosixRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join('/')
}
