import type {
  CatalogWorkspace,
  PlatformName,
  PluginConfigValue,
  PluginMeta,
  Scope,
} from '@lesliechan721/aw-plugin-core'

import type { CatalogWorkspaceResolvedFrom } from '../commands/catalog-workspace-resolution.js'
import type { PluginConfigSource } from '../utils/plugin-config.js'

export type ReviewPlatform = PlatformName | 'agent-skills'

export type ReviewProfileConfig = Record<string, Record<string, PluginConfigValue>>

export interface ReviewProfile {
  kind: 'review'
  id: `${ReviewPlatform}-${Scope}`
  platform: ReviewPlatform
  scope: Scope
  inputDigest: string
  config: ReviewProfileConfig
}

export type ReviewSkillSourceKind =
  | 'source-skill'
  | 'portable-source-skill'
  | 'artifact-source'

export type ReviewSkillDelivery =
  | 'static'
  | 'aw-extension'
  | 'codex-native'
  | 'agent-skills'

export interface ReviewSelectedSkill {
  plugin: PluginMeta
  pluginName: string
  name: string
  sourcePath: string
  sourcePaths: string[]
  sourceKind: ReviewSkillSourceKind
  targetId: string | null
  dynamic: boolean
  delivery: ReviewSkillDelivery
  configScope: Scope
  configScopes: Record<string, Scope>
  refreshKeys: string[]
}

export interface ReviewPluginProfileConfig {
  plugin: PluginMeta
  pluginName: string
  scope: Scope
  overrides: Record<string, PluginConfigValue>
  values: Record<string, PluginConfigValue>
  sources: Record<string, PluginConfigSource>
  digest: string
}

export interface ReviewResolvedProfile {
  profile: ReviewProfile
  platform: ReviewPlatform
  scope: Scope
  skills: ReviewSelectedSkill[]
  pluginConfigs: ReviewPluginProfileConfig[]
  sources: string[]
}

export interface ReviewSelectionTarget {
  kind: 'skill' | 'plugin' | 'catalog'
  path: string
  plugins: PluginMeta[]
  skill?: string
}

export interface ReviewSelection {
  workspace: CatalogWorkspace
  workspaceResolvedFrom: CatalogWorkspaceResolvedFrom
  sourceIdentity: string
  target: ReviewSelectionTarget
  profiles: ReviewResolvedProfile[]
  sources: string[]
}

export type ReviewSelectionErrorCode =
  | 'invalidArguments'
  | 'invalidConfig'
  | 'requiredConfigMissing'
  | 'sourceSkillAmbiguous'
  | 'targetNotFound'
  | 'unsupportedProfile'

export class ReviewSelectionError extends Error {
  readonly code: ReviewSelectionErrorCode
  readonly exitCode: 2 | 3
  reviewTarget?: Pick<ReviewSelectionTarget, 'kind' | 'path'>

  constructor(code: ReviewSelectionErrorCode, message: string, exitCode: 2 | 3 = 2) {
    super(`${code}: ${message}`)
    this.name = 'ReviewSelectionError'
    this.code = code
    this.exitCode = exitCode
  }

  withTarget(target: Pick<ReviewSelectionTarget, 'kind' | 'path'>): this {
    this.reviewTarget ??= { kind: target.kind, path: target.path }
    return this
  }
}
