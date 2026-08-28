import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { sanitizedGitEnvironment } from './catalog-publication-inspection.js'

const execFileAsync = promisify(execFile)

export type CatalogRemoteResolvedFrom = 'explicit' | 'origin' | 'sole-remote' | 'ambiguous' | 'unavailable'
export type CatalogBranchResolvedFrom = 'explicit' | 'default'

export interface CatalogPublicationTarget {
  repositoryRoot: string | null
  remote: string | null
  remoteResolvedFrom: CatalogRemoteResolvedFrom
  branch: string
  branchResolvedFrom: CatalogBranchResolvedFrom
  ambiguous: boolean
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return (await execFileAsync('git', args, {
    cwd,
    env: { ...sanitizedGitEnvironment(env), GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
  })).stdout.trim()
}

export async function resolveCatalogPublicationTarget(options: {
  workspaceRoot: string
  remote?: string
  branch?: string
  env: NodeJS.ProcessEnv
  requireRemote?: boolean
}): Promise<CatalogPublicationTarget> {
  const branch = options.branch ?? 'catalog'
  const branchResolvedFrom = options.branch === undefined ? 'default' : 'explicit'
  let repositoryRoot: string | null = null
  let remotes: string[] = []
  try {
    repositoryRoot = await git(options.workspaceRoot, ['rev-parse', '--show-toplevel'], options.env)
    remotes = (await git(repositoryRoot, ['remote'], options.env)).split('\n').filter(Boolean).sort()
  } catch {
    if (options.requireRemote) throw new Error('Catalog publication requires a readable Git worktree and remote.')
  }

  let remote: string | null = null
  let remoteResolvedFrom: CatalogRemoteResolvedFrom
  if (options.remote !== undefined) {
    remote = options.remote
    remoteResolvedFrom = 'explicit'
  } else if (remotes.includes('origin')) {
    remote = 'origin'
    remoteResolvedFrom = 'origin'
  } else if (remotes.length === 1) {
    remote = remotes[0]!
    remoteResolvedFrom = 'sole-remote'
  } else if (remotes.length > 1) {
    remoteResolvedFrom = 'ambiguous'
  } else {
    remoteResolvedFrom = 'unavailable'
  }
  if (options.requireRemote && remote === null) {
    if (remoteResolvedFrom === 'ambiguous') {
      throw new Error(`Catalog publication remote is ambiguous: ${remotes.join(', ')}. Use --remote.`)
    }
    throw new Error('Catalog publication remote is unavailable. Configure a Git remote or use --remote.')
  }
  return {
    repositoryRoot,
    remote,
    remoteResolvedFrom,
    branch,
    branchResolvedFrom,
    ambiguous: remoteResolvedFrom === 'ambiguous',
  }
}
