import path from 'node:path'

import fs from 'fs-extra'

import {
  CATALOG_WORKSPACE_MARKER_FILENAME,
  readCatalogWorkspaceMarker,
} from './workspace.js'

async function startDirectory(value: string): Promise<string> {
  const resolved = path.resolve(value)
  const stat = await fs.lstat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (stat?.isSymbolicLink()) throw new Error(`Catalog Workspace discovery path must not be a symbolic link: ${resolved}`)
  return stat?.isFile() ? path.dirname(resolved) : resolved
}

export async function findNearestCatalogWorkspaceRoot(options: {
  from: string
}): Promise<string | null> {
  let current = await startDirectory(options.from)
  for (;;) {
    const markerPath = path.join(current, CATALOG_WORKSPACE_MARKER_FILENAME)
    const markerStat = await fs.lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (markerStat) {
      await readCatalogWorkspaceMarker(current)
      return fs.realpath(current)
    }
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}
