import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { resolveCodexEvalRuntimeConfig } from './codex-eval-runtime-config.js'
import { BUILTIN_EVAL_PROVIDER_IDS, type BuiltinEvalProviderId } from './providers.js'
import { CODEX_PROVIDER_ENVIRONMENT_ALLOWLIST } from './custom-process.js'
import { credentialEnvironmentNames } from './credentials.js'
import {
  codexPermissionProfileStatus,
  normalizedCodexPermissionProfile,
} from './eval-process-management.js'
import {
  inspectCodexEvalKeychain,
  type CodexEvalKeychainInspection,
} from './codex-eval-isolation.js'
import {
  assertProcessTreeInspectionAvailable,
  type ProcessTreeDependencies,
} from './process-tree.js'

export interface EvalProviderDoctorResult {
  providers: BuiltinEvalProviderId[]
  codex: {
    requestedExecutable: string
    resolvedExecutable: string | null
    runtimeConfig: {
      model: string | null
      modelProvider: string
      credentialSource: string
    }
  }
  credentials: Array<{ name: string; present: boolean }>
  permission: {
    profile: string | null
    status: 'full-access' | 'restricted' | 'unknown'
  }
  keychain: CodexEvalKeychainInspection
  processManagement: {
    managedAvailable: boolean
    unmanagedAvailable: boolean
    defaultMode: 'managed' | 'blocked'
  }
  cleanup: {
    platform: NodeJS.Platform
    supported: boolean
    mechanism: 'process-tree' | 'unsupported'
  }
}

export interface EvalProviderDoctorOptions {
  sourceEnv?: NodeJS.ProcessEnv
  codexBin?: string
  model?: string
  platform?: NodeJS.Platform
  processTree?: ProcessTreeDependencies
  canAccess?: (candidate: string) => Promise<boolean>
  checkCleanup?: (platform: NodeJS.Platform) => Promise<boolean>
  readUserKeychainSearchList?: () => Promise<string>
}

async function defaultCanAccess(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function resolveExecutable(options: {
  executable: string
  sourceEnv: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  canAccess: (candidate: string) => Promise<boolean>
}): Promise<string | null> {
  const extensions = options.platform === 'win32' && path.extname(options.executable) === ''
    ? (options.sourceEnv.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  const names = path.isAbsolute(options.executable) ||
    options.executable.includes('/') || options.executable.includes('\\')
    ? [options.executable]
    : (options.sourceEnv.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap((directory) =>
        extensions.map((extension) => path.join(directory, `${options.executable}${extension}`)))
  for (const candidate of names) {
    if (await options.canAccess(candidate)) return path.resolve(candidate)
  }
  return null
}

export async function doctorEvalProviders(
  options: EvalProviderDoctorOptions = {},
): Promise<EvalProviderDoctorResult> {
  const sourceEnv = options.sourceEnv ?? process.env
  const platform = options.platform ?? process.platform
  const requestedExecutable = options.codexBin ?? sourceEnv.AW_SKILL_EVAL_CODEX_BIN ?? 'codex'
  const runtime = await resolveCodexEvalRuntimeConfig({
    inheritUserConfig: true,
    sourceEnv,
    modelOverride: options.model ?? sourceEnv.AW_SKILL_EVAL_CODEX_MODEL,
  })
  const resolvedExecutable = await resolveExecutable({
    executable: requestedExecutable,
    sourceEnv,
    platform,
    canAccess: options.canAccess ?? defaultCanAccess,
  })
  const platformCanClean = platform === 'darwin' || platform === 'linux'
  const cleanupSupported = platformCanClean && await (
    options.checkCleanup ?? (async (currentPlatform: NodeJS.Platform) => {
      try {
        await assertProcessTreeInspectionAvailable({
          ...options.processTree,
          platform: currentPlatform,
        })
        return true
      } catch {
        return false
      }
    })
  )(platform)
  const permission = {
    profile: normalizedCodexPermissionProfile(sourceEnv),
    status: codexPermissionProfileStatus(sourceEnv),
  }
  const keychain = await inspectCodexEvalKeychain({
    platform,
    sourceEnv,
    codexBin: requestedExecutable,
    resolveCodexExecutable: async () => resolvedExecutable,
    ...(options.readUserKeychainSearchList
      ? { readUserKeychainSearchList: options.readUserKeychainSearchList }
      : {}),
  })
  const keychainAllowsRun = keychain.status === 'safe' || keychain.status === 'not-applicable'
  const managedAvailable = permission.status !== 'restricted'
    && keychainAllowsRun
    && cleanupSupported
  return {
    providers: [...BUILTIN_EVAL_PROVIDER_IDS],
    codex: {
      requestedExecutable,
      resolvedExecutable,
      runtimeConfig: {
        model: runtime.model,
        modelProvider: runtime.modelProvider,
        credentialSource: runtime.credentialSource,
      },
    },
    credentials: [...new Set([
      ...credentialEnvironmentNames(CODEX_PROVIDER_ENVIRONMENT_ALLOWLIST),
      ...Object.keys(runtime.providerEnvironment),
    ])].sort().map((name) => ({
      name,
      present: sourceEnv[name] !== undefined && sourceEnv[name] !== '',
    })),
    permission,
    keychain,
    processManagement: {
      managedAvailable,
      unmanagedAvailable: keychainAllowsRun,
      defaultMode: managedAvailable ? 'managed' : 'blocked',
    },
    cleanup: {
      platform,
      supported: cleanupSupported,
      mechanism: cleanupSupported ? 'process-tree' : 'unsupported',
    },
  }
}
