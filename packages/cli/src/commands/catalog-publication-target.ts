import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { sanitizedGitEnvironment } from './catalog-publication-inspection.js'

const execFileAsync = promisify(execFile)

export type CatalogRemoteResolvedFrom = 'explicit' | 'invalid-explicit' | 'origin' | 'sole-remote' | 'ambiguous' | 'unavailable'
export type CatalogBranchResolvedFrom = 'explicit' | 'default'

export interface CatalogPublicationTarget {
  repositoryRoot: string | null
  remote: string | null
  remoteResolvedFrom: CatalogRemoteResolvedFrom
  branch: string
  branchResolvedFrom: CatalogBranchResolvedFrom
  branchValid: boolean
  ambiguous: boolean
}

function safeExplicitGitValue(value: string): boolean {
  return value !== '' && value === value.trim() && !/^-/u.test(value) && !/[\s\p{Cc}]/u.test(value)
}

function safeExplicitBranchValue(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
}

async function gitAcceptsBranch(cwd: string, branch: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!safeExplicitBranchValue(branch)) return false
  try {
    await execFileAsync('git', ['check-ref-format', '--branch', branch], {
      cwd,
      env: { ...sanitizedGitEnvironment(env), GIT_OPTIONAL_LOCKS: '0' },
      encoding: 'utf8',
    })
    return true
  } catch {
    return false
  }
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
  const branchValid = options.branch === undefined
    || await gitAcceptsBranch(options.workspaceRoot, branch, options.env)
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
    if (safeExplicitGitValue(options.remote) && remotes.includes(options.remote)) {
      remote = options.remote
      remoteResolvedFrom = 'explicit'
    } else {
      remoteResolvedFrom = 'invalid-explicit'
    }
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
    if (remoteResolvedFrom === 'invalid-explicit') {
      throw new Error('Catalog publication remote must name an existing Git remote exactly.')
    }
    if (remoteResolvedFrom === 'ambiguous') {
      throw new Error(`Catalog publication remote is ambiguous: ${remotes.join(', ')}. Use --remote.`)
    }
    throw new Error('Catalog publication remote is unavailable. Configure a Git remote or use --remote.')
  }
  if (options.requireRemote && !branchValid) {
    throw new Error('Catalog publication branch is not a safe Git branch name.')
  }
  return {
    repositoryRoot,
    remote,
    remoteResolvedFrom,
    branch,
    branchResolvedFrom,
    branchValid,
    ambiguous: remoteResolvedFrom === 'ambiguous',
  }
}
