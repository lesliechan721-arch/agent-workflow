import process from 'node:process'
import { assertCodexEvalKeychainWrapperAbsent } from './codex-eval-isolation.js'
import type { EvalResultProcessManagement } from './eval-result.js'
import {
  assertProcessTreeInspectionAvailable,
  type ProcessTreeDependencies,
} from './process-tree.js'

const FULL_ACCESS_PERMISSION_PROFILE = 'danger-full-access'
const UNMANAGED_LIMITATION =
  'Only the direct provider child is targeted; descendant discovery and cleanup are not available.'
const MANAGED_LIMITATION =
  'Process-tree inspection verifies cooperative descendants, but it is not OS-enforced containment and does not guarantee descendant cleanup.'
const UNMANAGED_RISK =
  'Unmanaged mode skips process-tree inspection, targets only the direct provider child, and can leave descendant processes running. It does not bypass the macOS keychain or cmux checks.'

export interface EvalProcessManagementDependencies {
  platform?: NodeJS.Platform
  resolveCodexExecutable?: (options: {
    executable: string
    sourceEnv: NodeJS.ProcessEnv
    platform: NodeJS.Platform
  }) => Promise<string | null>
  readUserKeychainSearchList?: () => Promise<string>
  inspectProcessTree?: () => Promise<void>
  processTree?: ProcessTreeDependencies
}

export function normalizedCodexPermissionProfile(
  sourceEnv: NodeJS.ProcessEnv,
): string | null {
  const value = sourceEnv.CODEX_PERMISSION_PROFILE?.trim()
  if (!value) return null
  return value.replace(/^:/u, '')
}

export function codexPermissionProfileStatus(
  sourceEnv: NodeJS.ProcessEnv,
): 'full-access' | 'restricted' | 'unknown' {
  const profile = normalizedCodexPermissionProfile(sourceEnv)
  if (profile === null) return 'unknown'
  return profile === FULL_ACCESS_PERMISSION_PROFILE ? 'full-access' : 'restricted'
}

function restrictedSessionError(profile: string): Error {
  return new Error(
    `Model eval is blocked because CODEX_PERMISSION_PROFILE=${profile} does not identify ` +
    'a Full Access Codex session. A one-off sandbox_permissions=require_escalated request ' +
    'does not change the original permission profile. Do not retry with one-off elevation. ' +
    'Switch the entire session to Full Access or explicitly authorize ' +
    `--allow-unmanaged-processes. ${UNMANAGED_RISK} No keychain check, process-tree inspection, output ` +
    'directory, or model process was started.',
  )
}

export async function resolveEvalProcessManagement(options: {
  allowUnmanaged: boolean
  codexBin?: string
  sourceEnv?: NodeJS.ProcessEnv
  dependencies?: EvalProcessManagementDependencies
}): Promise<EvalResultProcessManagement> {
  const sourceEnv = options.sourceEnv ?? process.env
  const dependencies = options.dependencies ?? {}
  const platform = dependencies.platform ?? dependencies.processTree?.platform ?? process.platform
  const profile = normalizedCodexPermissionProfile(sourceEnv)
  const permissionStatus = codexPermissionProfileStatus(sourceEnv)

  if (permissionStatus === 'restricted' && !options.allowUnmanaged) {
    throw restrictedSessionError(profile!)
  }

  await assertCodexEvalKeychainWrapperAbsent({
    platform,
    sourceEnv,
    ...(options.codexBin ? { codexBin: options.codexBin } : {}),
    ...(dependencies.resolveCodexExecutable
      ? { resolveCodexExecutable: dependencies.resolveCodexExecutable }
      : {}),
    ...(dependencies.readUserKeychainSearchList
      ? { readUserKeychainSearchList: dependencies.readUserKeychainSearchList }
      : {}),
  })

  if (options.allowUnmanaged) {
    return {
      mode: 'unmanaged-confirmed',
      inspectionAvailable: false,
      userAcknowledged: true,
      descendantCleanupGuaranteed: false,
      limitation: UNMANAGED_LIMITATION,
      diagnostic: permissionStatus === 'restricted'
        ? `Restricted Codex permission profile ${profile} was explicitly accepted; process-tree inspection was skipped.`
        : 'Unmanaged process execution was explicitly accepted; process-tree inspection was skipped.',
    }
  }

  try {
    if (dependencies.inspectProcessTree) await dependencies.inspectProcessTree()
    else await assertProcessTreeInspectionAvailable({
      ...dependencies.processTree,
      platform,
    })
    return {
      mode: 'managed',
      inspectionAvailable: true,
      userAcknowledged: false,
      descendantCleanupGuaranteed: false,
      limitation: MANAGED_LIMITATION,
    }
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Full Access process management is unavailable. ${diagnostic} No output directory ` +
      'or model process was started. A one-off sandbox_permissions=require_escalated ' +
      'request is not Full Access. Switch the entire session to Full Access or explicitly ' +
      `authorize --allow-unmanaged-processes. ${UNMANAGED_RISK}`,
    )
  }
}
