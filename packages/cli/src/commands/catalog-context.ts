import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  getPluginCoreVersion,
  readCatalogWorkspace,
  resolveCatalogWorkspaceRoot,
} from '@lesliechan721/aw-plugin-core'

import { resolveCatalogPublicationTarget } from './catalog-publication-target.js'
import { suggestedCatalogDevSourceId } from './catalog-dev-source.js'
import { sanitizedGitEnvironment } from './catalog-publication-inspection.js'
import { CLI_RESERVED_IMPORTS } from '../utils/manifest.js'
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js'

const execFileAsync = promisify(execFile)

function digest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    return (await execFileAsync('git', args, {
      cwd,
      env: { ...sanitizedGitEnvironment(env), GIT_OPTIONAL_LOCKS: '0' },
      encoding: 'utf8',
    })).stdout.trim()
  } catch {
    return null
  }
}

export async function getCatalogContext(options: {
  cwd: string
  workspaceRoot?: string
  remote?: string
  branch?: string
  env: NodeJS.ProcessEnv
  awVersion: string
  capabilities: readonly string[]
}) {
  const issues: Array<{ code: string; message: string; blocking: boolean }> = []
  let existing: Awaited<ReturnType<typeof resolveCatalogWorkspaceRoot>> | null = null
  let initialization: Awaited<ReturnType<typeof resolveCatalogWorkspaceRoot>> | null = null
  let workspaceIdentity: string | null = null
  try {
    existing = await resolveCatalogWorkspaceRoot({
      cwd: options.cwd,
      ...(options.workspaceRoot === undefined ? {} : { explicitRoot: options.workspaceRoot }),
      mode: 'existing',
    })
    workspaceIdentity = (await readCatalogWorkspace(existing.workspaceRoot, {
      reservedImports: CLI_RESERVED_IMPORTS,
    })).workspaceIdentity
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const blocking = !message.startsWith('Catalog Workspace marker not found from:')
    issues.push({
      code: blocking ? 'workspaceInvalid' : 'workspaceUnavailable',
      message,
      blocking,
    })
  }
  try {
    initialization = await resolveCatalogWorkspaceRoot({
      cwd: options.cwd,
      ...(options.workspaceRoot === undefined ? {} : { explicitRoot: options.workspaceRoot }),
      mode: 'initialize',
    })
  } catch (error) {
    if (!issues.some((issue) => issue.blocking)) {
      issues.push({
        code: 'workspaceInvalid',
        message: error instanceof Error ? error.message : String(error),
        blocking: true,
      })
    }
  }
  const inspectionRoot = existing?.workspaceRoot ?? initialization?.workspaceRoot ?? path.resolve(options.cwd)
  const target = await resolveCatalogPublicationTarget({
    workspaceRoot: inspectionRoot,
    remote: options.remote,
    branch: options.branch,
    env: options.env,
  })
  const repositoryRoot = target.repositoryRoot
  const sourceHead = repositoryRoot ? await git(repositoryRoot, ['rev-parse', '--verify', 'HEAD'], options.env) : null
  const status = repositoryRoot
    ? await git(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'], options.env)
    : null
  const remotesText = repositoryRoot ? await git(repositoryRoot, ['remote'], options.env) : null
  const remotes = remotesText ? remotesText.split('\n').filter(Boolean).sort() : []
  const capabilities = [...options.capabilities].sort()
  let suggestedSourceId = suggestedCatalogDevSourceId(inspectionRoot)
  let existingSourceId: string | null = null
  let active = false
  if (workspaceIdentity !== null) {
    try {
      const sourceConfig = await readCatalogSourcesConfigSnapshot(options.env)
      const owned = sourceConfig.config.sources.filter((source): source is Extract<typeof source, { type: 'path' }> => source.type === 'path'
        && source.managedBy?.kind === 'catalog-workspace'
        && source.managedBy.workspaceIdentity === workspaceIdentity)
      if (owned.length > 1) {
        issues.push({
          code: 'managedSourceAmbiguous',
          message: `Catalog Workspace owns multiple development sources: ${owned.map((source) => source.id).join(', ')}.`,
          blocking: true,
        })
      } else if (owned.length === 1) {
        existingSourceId = owned[0]!.id
        active = owned[0]!.path === path.join(inspectionRoot, '.aw', 'catalog')
        suggestedSourceId = owned[0]!.id
      } else {
        suggestedSourceId = suggestedCatalogDevSourceId(
          inspectionRoot,
          workspaceIdentity,
          sourceConfig.config.sources.map((source) => source.id),
        )
      }
    } catch (error) {
      issues.push({
        code: 'sourceConfigInvalid',
        message: error instanceof Error ? error.message : String(error),
        blocking: true,
      })
    }
  }
  return {
    schemaVersion: 1,
    command: 'catalog:context',
    toolchain: {
      awVersion: options.awVersion,
      coreVersion: getPluginCoreVersion(),
      capabilities,
      digest: digest({ awVersion: options.awVersion, coreVersion: getPluginCoreVersion(), capabilities }),
    },
    workspace: {
      found: existing !== null && workspaceIdentity !== null,
      root: existing?.workspaceRoot ?? null,
      identity: workspaceIdentity,
      resolvedFrom: existing?.workspaceRootResolvedFrom ?? null,
    },
    initialization: {
      suggestedRoot: initialization?.workspaceRoot ?? null,
      resolvedFrom: initialization?.workspaceRootResolvedFrom ?? null,
    },
    git: {
      repositoryRoot,
      sourceHead,
      clean: status === null ? null : status === '',
      remotes,
    },
    publication: {
      remote: target.remote,
      remoteResolvedFrom: target.remoteResolvedFrom,
      branch: target.branch,
      branchResolvedFrom: target.branchResolvedFrom,
      ambiguous: target.ambiguous,
    },
    developmentSource: {
      snapshotPath: path.join(inspectionRoot, '.aw', 'catalog'),
      suggestedSourceId,
      existingSourceId,
      active,
    },
    issues,
  }
}
