import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import fs from 'fs-extra'

import { CATALOG_WORKSPACE_MARKER_FILENAME } from './workspace.js'

const execFileAsync = promisify(execFile)

export type CatalogWorkspaceResolvedFrom = 'explicit' | 'workspace-marker' | 'git-worktree' | 'cwd'

export interface CatalogWorkspaceResolution {
  workspaceRoot: string
  workspaceRootResolvedFrom: CatalogWorkspaceResolvedFrom
}

async function startDirectory(value: string): Promise<string> {
  const resolved = path.resolve(value)
  const stat = await fs.lstat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (stat?.isSymbolicLink()) throw new Error(`Catalog Workspace discovery path must not be a symbolic link: ${resolved}`)
  return stat?.isFile() ? path.dirname(resolved) : resolved
}

async function validateMarker(root: string): Promise<void> {
  const markerPath = path.join(root, CATALOG_WORKSPACE_MARKER_FILENAME)
  const stat = await fs.lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Invalid Catalog Workspace marker: ${markerPath}`)
  }
  let marker: unknown
  try {
    marker = await fs.readJson(markerPath)
  } catch {
    throw new Error(`Invalid Catalog Workspace marker: ${markerPath}`)
  }
  const record = marker as Record<string, unknown>
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || Object.keys(record).sort().join('\0') !== ['kind', 'schemaVersion', 'workspaceIdentity'].join('\0')
    || record.schemaVersion !== 1
    || record.kind !== 'aw-catalog-workspace'
    || typeof record.workspaceIdentity !== 'string'
    || record.workspaceIdentity.trim() === ''
  ) {
    throw new Error(`Invalid Catalog Workspace marker: ${markerPath}`)
  }
}

async function findAncestorWorkspace(from: string): Promise<string | null> {
  let current = await startDirectory(from)
  for (;;) {
    const markerPath = path.join(current, CATALOG_WORKSPACE_MARKER_FILENAME)
    const markerStat = await fs.lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (markerStat) {
      await validateMarker(current)
      return fs.realpath(current)
    }
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function findGitWorktreeRoot(cwd: string): Promise<string | null> {
  try {
    const env = { ...process.env }
    delete env.GIT_DIR
    delete env.GIT_WORK_TREE
    delete env.GIT_COMMON_DIR
    env.GIT_OPTIONAL_LOCKS = '0'
    const result = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: await startDirectory(cwd),
      env,
      encoding: 'utf8',
    })
    return fs.realpath(result.stdout.trim())
  } catch {
    return null
  }
}

export async function resolveCatalogWorkspaceRoot(options: {
  cwd: string
  explicitRoot?: string
  mode: 'existing' | 'initialize'
}): Promise<CatalogWorkspaceResolution> {
  if (options.explicitRoot !== undefined) {
    const workspaceRoot = path.resolve(options.cwd, options.explicitRoot)
    if (options.mode === 'existing') await validateMarker(workspaceRoot)
    return { workspaceRoot, workspaceRootResolvedFrom: 'explicit' }
  }

  const ancestor = await findAncestorWorkspace(options.cwd)
  if (ancestor) {
    return { workspaceRoot: ancestor, workspaceRootResolvedFrom: 'workspace-marker' }
  }
  if (options.mode === 'existing') {
    throw new Error(`Catalog Workspace marker not found from: ${path.resolve(options.cwd)}`)
  }
  const gitRoot = await findGitWorktreeRoot(options.cwd)
  if (gitRoot) return { workspaceRoot: gitRoot, workspaceRootResolvedFrom: 'git-worktree' }
  return { workspaceRoot: await startDirectory(options.cwd), workspaceRootResolvedFrom: 'cwd' }
}
