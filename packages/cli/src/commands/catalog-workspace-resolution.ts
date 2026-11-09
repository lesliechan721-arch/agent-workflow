import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import fs from 'fs-extra'
import {
  CATALOG_WORKSPACE_MARKER_FILENAME,
  findNearestCatalogWorkspaceRoot,
  readCatalogWorkspaceMarker,
} from '@lesliechan721/aw-plugin-core'

import { sanitizedGitEnvironment } from './catalog-publication-inspection.js'

const execFileAsync = promisify(execFile)

export class CatalogWorkspaceMissingError extends Error {
  readonly code = 'catalogWorkspaceMissing'

  constructor() {
    super('A Catalog Workspace is required. Run aw dev catalog create to create one explicitly.')
    this.name = 'CatalogWorkspaceMissingError'
  }
}

export type CatalogWorkspaceResolvedFrom = 'explicit' | 'workspace-marker' | 'git-worktree' | 'cwd'

export interface CatalogWorkspaceResolution {
  workspaceRoot: string
  workspaceRootResolvedFrom: CatalogWorkspaceResolvedFrom
}

export type CatalogWorkspaceGitRootRunner = (
  cwd: string,
  env: NodeJS.ProcessEnv,
) => Promise<string | null>

async function findGitWorktreeRoot(cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      env: { ...sanitizedGitEnvironment(env), GIT_OPTIONAL_LOCKS: '0' },
      encoding: 'utf8',
    })
    const root = result.stdout.trim()
    return root === '' ? null : fs.realpath(root)
  } catch {
    return null
  }
}

export async function resolveCatalogWorkspaceRoot(options: {
  cwd: string
  explicitRoot?: string
  mode: 'existing' | 'initialize'
  env?: NodeJS.ProcessEnv
  gitRootRunner?: CatalogWorkspaceGitRootRunner
}): Promise<CatalogWorkspaceResolution> {
  if (options.explicitRoot !== undefined) {
    const workspaceRoot = path.resolve(options.cwd, options.explicitRoot)
    if (options.mode === 'existing') {
      await fs.lstat(path.join(workspaceRoot, CATALOG_WORKSPACE_MARKER_FILENAME))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') throw new CatalogWorkspaceMissingError()
          throw error
        })
      // Existing malformed or symbolic markers retain the original validation error.
      await readCatalogWorkspaceMarker(workspaceRoot)
    }
    return { workspaceRoot, workspaceRootResolvedFrom: 'explicit' }
  }

  const ancestor = await findNearestCatalogWorkspaceRoot({ from: options.cwd })
  if (ancestor !== null) {
    return { workspaceRoot: ancestor, workspaceRootResolvedFrom: 'workspace-marker' }
  }
  if (options.mode === 'existing') {
    throw new CatalogWorkspaceMissingError()
  }
  const gitRoot = await (options.gitRootRunner ?? findGitWorktreeRoot)(
    path.resolve(options.cwd),
    options.env ?? process.env,
  )
  if (gitRoot !== null) {
    return { workspaceRoot: gitRoot, workspaceRootResolvedFrom: 'git-worktree' }
  }
  return { workspaceRoot: path.resolve(options.cwd), workspaceRootResolvedFrom: 'cwd' }
}
