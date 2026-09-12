import path from 'node:path'

import {
  calculateCatalogWorkspaceSourceIdentity,
  readCatalogWorkspace,
  resolveSupportedPlatforms,
  type CatalogWorkspace,
  type PluginArtifactTargetDefinition,
  type PluginMeta,
  type Scope,
} from '@lesliechan721/aw-plugin-core'
import fs from 'fs-extra'

import {
  resolveCatalogWorkspaceRoot,
  type CatalogWorkspaceResolution,
} from '../commands/catalog-workspace-resolution.js'
import { CLI_RESERVED_IMPORTS } from '../utils/manifest.js'
import { resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js'
import { codexNativeRefreshKeys } from '../utils/plugin-config.js'
import {
  createReviewProfile,
  normalizeReviewProfileConfig,
  resolveReviewPluginProfileConfig,
} from './review-profile.js'
import {
  ReviewSelectionError,
  type ReviewPlatform,
  type ReviewPluginProfileConfig,
  type ReviewProfile,
  type ReviewProfileConfig,
  type ReviewResolvedProfile,
  type ReviewSelectedSkill,
  type ReviewSelection,
  type ReviewSelectionTarget,
  type ReviewSkillDelivery,
  type ReviewSkillSourceKind,
} from './review-types.js'

interface ReviewSkillDeclaration extends ReviewSelectedSkill {
  platform: ReviewPlatform
  scope: Scope
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function stripDotSlash(value: string): string {
  return value.replace(/^\.\//u, '')
}

function declarationKey(value: ReviewSkillDeclaration): string {
  return [value.pluginName, value.name, value.platform, value.scope, value.targetId ?? 'static'].join('\0')
}

function isSkillTarget(target: PluginArtifactTargetDefinition): boolean {
  return target.target === 'codex.skill'
    || target.target === 'claude.skill'
    || target.target === 'agent-skills.skill'
}

function targetPlatform(target: PluginArtifactTargetDefinition): ReviewPlatform {
  return target.target === 'agent-skills.skill'
    ? 'agent-skills'
    : target.target === 'codex.skill' ? 'codex' : 'claude'
}

function targetDelivery(target: PluginArtifactTargetDefinition): ReviewSkillDelivery {
  if (target.target === 'agent-skills.skill') return 'agent-skills'
  if (target.target === 'codex.skill') return target.delivery.mode
  return 'aw-extension'
}

async function directSkillDirectories(
  plugin: PluginMeta,
  collection: string,
): Promise<Array<{ name: string; path: string }>> {
  const root = path.join(plugin.rootDir, stripDotSlash(collection))
  const entries = await fs.readdir(root, { withFileTypes: true })
  const skills: Array<{ name: string; path: string }> = []
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const candidate = path.join(root, entry.name)
    const info = await fs.lstat(candidate)
    if (!entry.isDirectory() || !info.isDirectory() || info.isSymbolicLink()) {
      throw new ReviewSelectionError(
        'targetNotFound',
        `Skill collection contains an unsafe direct child: ${candidate}`,
      )
    }
    skills.push({ name: entry.name, path: await fs.realpath(candidate) })
  }
  return skills
}

async function canonicalDeclaredPaths(plugin: PluginMeta, target: PluginArtifactTargetDefinition): Promise<string[]> {
  const declared = target.sourceDirs?.length
    ? target.sourceDirs.map((entry) => path.join(plugin.rootDir, stripDotSlash(entry)))
    : plugin.manifest.scripts?.artifacts?.render?.path
      ? [path.join(plugin.rootDir, stripDotSlash(plugin.manifest.scripts.artifacts.render.path))]
      : [plugin.manifestPath]
  const result: string[] = []
  for (const candidate of declared) {
    const real = await fs.realpath(candidate)
    if (!result.includes(real)) result.push(real)
  }
  return result.sort(compareText)
}

async function inventoryPluginSkills(plugin: PluginMeta): Promise<ReviewSkillDeclaration[]> {
  const nativeSkills = plugin.manifest.skills
    ? await directSkillDirectories(plugin, plugin.manifest.skills)
    : []
  const portableSkills = plugin.manifest.distributions?.agentSkills?.skills
    ? await directSkillDirectories(plugin, plugin.manifest.distributions.agentSkills.skills)
    : []
  const declarations: ReviewSkillDeclaration[] = []
  const dynamicProfiles = new Set((plugin.manifest.artifacts?.targets ?? [])
    .filter(isSkillTarget)
    .flatMap((target) => target.scopes.map((scope) =>
      `${targetPlatform(target)}\0${scope}\0${target.skillKey}`)))

  for (const platform of [...resolveSupportedPlatforms(plugin.manifest)].sort(compareText)) {
    for (const skill of nativeSkills) {
      for (const scope of ['project', 'user'] as const) {
        if (dynamicProfiles.has(`${platform}\0${scope}\0${skill.name}`)) continue
        declarations.push({
          plugin,
          pluginName: plugin.manifest.name,
          name: skill.name,
          sourcePath: skill.path,
          sourcePaths: [skill.path],
          sourceKind: 'source-skill',
          targetId: null,
          dynamic: false,
          delivery: 'static',
          configScope: scope,
          configScopes: {},
          refreshKeys: [],
          platform,
          scope,
        })
      }
    }
  }

  if (plugin.manifest.distributions?.agentSkills) {
    for (const skill of portableSkills) {
      for (const scope of ['project', 'user'] as const) {
        if (dynamicProfiles.has(`agent-skills\0${scope}\0${skill.name}`)) continue
        declarations.push({
          plugin,
          pluginName: plugin.manifest.name,
          name: skill.name,
          sourcePath: skill.path,
          sourcePaths: [skill.path],
          sourceKind: 'portable-source-skill',
          targetId: null,
          dynamic: false,
          delivery: 'static',
          configScope: scope,
          configScopes: {},
          refreshKeys: [],
          platform: 'agent-skills',
          scope,
        })
      }
    }
  }

  for (const target of plugin.manifest.artifacts?.targets ?? []) {
    if (!isSkillTarget(target)) continue
    const sourcePaths = await canonicalDeclaredPaths(plugin, target)
    const sourceKind: ReviewSkillSourceKind = target.target === 'agent-skills.skill'
      && portableSkills.some((skill) => sourcePaths.includes(skill.path))
      ? 'portable-source-skill'
      : sourcePaths.some((sourcePath) => nativeSkills.some((skill) => skill.path === sourcePath))
        ? 'source-skill'
        : 'artifact-source'
    const refreshKeys = [...target.refreshKeys].sort(compareText)
    const configScope = target.delivery?.mode === 'codex-native' ? 'user' : undefined
    const userOnlyKeys = codexNativeRefreshKeys(plugin.manifest)
    for (const scope of target.scopes) {
      const targetConfigScope = configScope ?? scope
      declarations.push({
        plugin,
        pluginName: plugin.manifest.name,
        name: target.skillKey!,
        sourcePath: sourcePaths[0]!,
        sourcePaths,
        sourceKind,
        targetId: target.id,
        dynamic: true,
        delivery: targetDelivery(target),
        configScope: targetConfigScope,
        configScopes: Object.fromEntries(refreshKeys.map((key) => [
          key,
          userOnlyKeys.has(key) ? 'user' : targetConfigScope,
        ])),
        refreshKeys,
        platform: targetPlatform(target),
        scope,
      })
    }
  }
  return declarations.sort((left, right) => compareText(declarationKey(left), declarationKey(right)))
}

async function inventorySkills(plugins: readonly PluginMeta[]): Promise<ReviewSkillDeclaration[]> {
  return (await Promise.all(plugins.map(inventoryPluginSkills))).flat()
    .sort((left, right) => compareText(declarationKey(left), declarationKey(right)))
}

async function canonicalTargetCandidate(cwd: string, target: string): Promise<string | null> {
  if (target === 'catalog') return null
  const candidate = path.resolve(cwd, target)
  const info = await fs.lstat(candidate).catch(() => null)
  if (!info) return null
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
    throw new ReviewSelectionError('targetNotFound', `Review target is unsafe: ${candidate}`)
  }
  return fs.realpath(candidate)
}

async function resolveWorkspace(options: {
  cwd: string
  target: string
  workspaceRoot?: string
}): Promise<{ resolution: CatalogWorkspaceResolution; workspace: CatalogWorkspace; candidate: string | null }> {
  const candidate = await canonicalTargetCandidate(options.cwd, options.target)
  let resolution: CatalogWorkspaceResolution
  try {
    resolution = await resolveCatalogWorkspaceRoot({
      cwd: options.workspaceRoot === undefined && candidate !== null
        ? (await fs.lstat(candidate)).isDirectory() ? candidate : path.dirname(candidate)
        : options.cwd,
      ...(options.workspaceRoot === undefined ? {} : { explicitRoot: options.workspaceRoot }),
      mode: 'existing',
    })
  } catch (error) {
    throw new ReviewSelectionError(
      'targetNotFound',
      error instanceof Error ? error.message : 'Catalog Workspace cannot be resolved.',
    )
  }
  try {
    return {
      resolution,
      workspace: await readCatalogWorkspace(resolution.workspaceRoot, {
        reservedImports: CLI_RESERVED_IMPORTS,
      }),
      candidate,
    }
  } catch (error) {
    throw new ReviewSelectionError(
      'targetNotFound',
      error instanceof Error ? error.message : 'Catalog Workspace is invalid.',
    )
  }
}

function uniqueSkillNames(skills: readonly string[] | undefined): string[] {
  const result: string[] = []
  for (const skill of skills ?? []) {
    if (skill.trim() === '') {
      throw new ReviewSelectionError('invalidArguments', 'Skill names must be non-empty.')
    }
    if (!result.includes(skill)) result.push(skill)
  }
  return result.sort(compareText)
}

async function resolveTarget(options: {
  workspace: CatalogWorkspace
  target: string
  candidate: string | null
  skills: readonly string[]
  declarations: readonly ReviewSkillDeclaration[]
}): Promise<ReviewSelectionTarget> {
  if (options.target === 'catalog' || options.candidate === options.workspace.workspaceRoot) {
    return {
      kind: 'catalog',
      path: options.workspace.workspaceRoot,
      plugins: options.workspace.plugins,
    }
  }
  const named = options.workspace.plugins.find((plugin) => plugin.manifest.name === options.target)
  const plugin = named ?? options.workspace.plugins.find((entry) => entry.rootDir === options.candidate)
  if (plugin) return { kind: 'plugin', path: plugin.rootDir, plugins: [plugin] }
  if (options.candidate === null) {
    throw new ReviewSelectionError('targetNotFound', `Review target was not found: ${options.target}`)
  }

  const candidateInfo = await fs.lstat(options.candidate)
  const candidateRoot = candidateInfo.isFile() && path.basename(options.candidate) === 'SKILL.md'
    ? path.dirname(options.candidate)
    : options.candidate
  const matching = options.declarations.filter((entry) => entry.sourcePaths.includes(candidateRoot)
    || entry.sourcePaths.includes(options.candidate!))
  if (matching.length === 0) {
    throw new ReviewSelectionError(
      'targetNotFound',
      'Review target is not a canonical Plugin, Catalog, source Skill, or declared artifact source.',
    )
  }
  const names = [...new Set(matching.map((entry) => entry.name))].sort(compareText)
  let skill: string
  if (names.length === 1) {
    skill = names[0]!
  } else {
    const requested = options.skills.filter((entry) => names.includes(entry))
    if (requested.length !== 1) {
      throw new ReviewSelectionError(
        'sourceSkillAmbiguous',
        `Source path maps to multiple Skills (${names.join(', ')}); select one with --skill.`,
      )
    }
    skill = requested[0]!
  }
  if (options.skills.some((entry) => entry !== skill)) {
    throw new ReviewSelectionError(
      'invalidArguments',
      `Source Skill target maps to "${skill}"; a different --skill cannot widen its scope.`,
    )
  }
  const owners = [...new Map(matching.filter((entry) => entry.name === skill)
    .map((entry) => [entry.pluginName, entry.plugin])).values()]
  if (owners.length !== 1) {
    throw new ReviewSelectionError('sourceSkillAmbiguous', 'Source Skill ownership is ambiguous.')
  }
  return {
    kind: 'skill',
    path: candidateRoot,
    plugins: owners,
    skill,
  }
}

async function readReviewConfig(options: {
  cwd: string
  configFile?: string
  config?: ReviewProfileConfig
}): Promise<ReviewProfileConfig> {
  if (options.configFile !== undefined && options.config !== undefined) {
    throw new ReviewSelectionError('invalidArguments', 'configFile and config cannot be used together.')
  }
  if (options.config !== undefined) {
    try {
      return normalizeReviewProfileConfig(options.config)
    } catch (error) {
      throw new ReviewSelectionError(
        'invalidConfig',
        error instanceof Error ? error.message : 'Review config is invalid.',
      )
    }
  }
  if (options.configFile === undefined) return {}
  const configPath = path.resolve(options.cwd, options.configFile)
  try {
    const info = await fs.lstat(configPath)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Config path must be a regular file.')
    return normalizeReviewProfileConfig(await fs.readJson(configPath) as unknown)
  } catch (error) {
    throw new ReviewSelectionError(
      'invalidConfig',
      `Cannot read Review config "${configPath}": ${error instanceof Error ? error.message : 'invalid file'}`,
    )
  }
}

function validateConfigPlugins(
  workspace: CatalogWorkspace,
  config: ReviewProfileConfig,
): void {
  for (const pluginName of Object.keys(config)) {
    const plugin = workspace.plugins.find((entry) => entry.manifest.name === pluginName)
    if (!plugin) {
      throw new ReviewSelectionError('invalidConfig', `Review config names unknown plugin "${pluginName}".`)
    }
    resolveReviewPluginProfileConfig({ plugin, scope: 'user', config, keys: [] })
  }
}

function filterRequestedSkills(options: {
  target: ReviewSelectionTarget
  declarations: readonly ReviewSkillDeclaration[]
  skills: readonly string[]
}): ReviewSkillDeclaration[] {
  const pluginNames = new Set(options.target.plugins.map((plugin) => plugin.manifest.name))
  let candidates = options.declarations.filter((entry) => pluginNames.has(entry.pluginName))
  const requested = options.target.kind === 'skill' ? [options.target.skill!] : options.skills
  for (const skill of requested) {
    const owners = [...new Set(candidates.filter((entry) => entry.name === skill)
      .map((entry) => entry.pluginName))]
    if (owners.length === 0) {
      throw new ReviewSelectionError('invalidArguments', `Selected Skill is not declared by the target: ${skill}`)
    }
    if (owners.length > 1) {
      throw new ReviewSelectionError(
        'invalidArguments',
        `Selected Skill name "${skill}" is owned by multiple target plugins: ${owners.sort(compareText).join(', ')}.`,
      )
    }
  }
  if (requested.length > 0) {
    const selected = new Set(requested)
    candidates = candidates.filter((entry) => selected.has(entry.name))
  }
  return candidates
}

function runtimeExportSource(workspace: CatalogWorkspace, pluginName: string, exportName: string): string | null {
  const provider = workspace.plugins.find((plugin) => plugin.manifest.name === pluginName)
  const entry = provider?.manifest.buildConfig?.runtimeExports?.find((item) => item.name === exportName)
  return provider && entry ? path.join(provider.rootDir, stripDotSlash(entry.source)) : null
}

function profileSources(options: {
  workspace: CatalogWorkspace
  skills: readonly ReviewSkillDeclaration[]
}): string[] {
  const sources = new Set<string>()
  const closure = resolvePluginMetaDependencyClosure(
    options.workspace.plugins,
    [...new Set(options.skills.map((skill) => skill.pluginName))],
  )
  for (const plugin of closure) {
    sources.add(plugin.manifestPath)
    const build = plugin.manifest.scripts?.node?.build?.path
    if (build) sources.add(path.join(plugin.rootDir, stripDotSlash(build)))
    for (const entry of plugin.manifest.buildConfig?.buildImports ?? []) {
      const source = runtimeExportSource(options.workspace, entry.plugin, entry.export)
      if (source) sources.add(source)
    }
  }
  for (const skill of options.skills) {
    skill.sourcePaths.forEach((entry) => sources.add(entry))
    if (!skill.dynamic) {
      for (const entry of skill.plugin.manifest.buildConfig?.skillRuntimeFiles ?? []) {
        const native = skill.platform !== 'agent-skills'
          && (entry.platforms?.includes(skill.platform) ?? entry.distributions === undefined)
        const portable = skill.platform === 'agent-skills'
          && (entry.distributions?.includes('agent-skills') ?? false)
        if (entry.skill !== skill.name || (!native && !portable)) continue
        if (entry.source) sources.add(path.join(skill.plugin.rootDir, stripDotSlash(entry.source)))
        if (entry.import) {
          const source = runtimeExportSource(options.workspace, entry.import.plugin, entry.import.export)
          if (source) sources.add(source)
        }
      }
    }
    if (skill.targetId) {
      const target = skill.plugin.manifest.artifacts?.targets?.find((entry) => entry.id === skill.targetId)
      for (const entry of target?.runtimeImports ?? []) {
        const source = runtimeExportSource(options.workspace, entry.plugin, entry.export)
        if (source) sources.add(source)
      }
    }
  }
  return [...sources].sort(compareText)
}

function buildProfile(options: {
  workspace: CatalogWorkspace
  platform: ReviewPlatform
  scope: Scope
  skills: readonly ReviewSkillDeclaration[]
  config: ReviewProfileConfig
}): ReviewResolvedProfile {
  const selectedSkills = options.skills.map(({ platform: _platform, scope: _scope, ...skill }) => skill)
  const configKeys = new Map<string, Set<string>>()
  for (const skill of selectedSkills.filter((entry) => entry.dynamic)) {
    for (const refreshKey of skill.refreshKeys) {
      const scope = skill.configScopes[refreshKey] ?? skill.configScope
      const key = `${skill.pluginName}\0${scope}`
      const keys = configKeys.get(key) ?? new Set<string>()
      keys.add(refreshKey)
      configKeys.set(key, keys)
    }
  }
  const pluginConfigs: ReviewPluginProfileConfig[] = []
  for (const [key, keys] of [...configKeys].sort(([left], [right]) => compareText(left, right))) {
    const [pluginName, configScope] = key.split('\0') as [string, Scope]
    const plugin = options.workspace.plugins.find((entry) => entry.manifest.name === pluginName)!
    pluginConfigs.push(resolveReviewPluginProfileConfig({
      plugin,
      scope: configScope,
      config: options.config,
      keys: [...keys].sort(compareText),
    }))
  }
  const effectiveConfig: ReviewProfileConfig = {}
  for (const entry of pluginConfigs) {
    if (Object.keys(entry.overrides).length === 0) continue
    effectiveConfig[entry.pluginName] = {
      ...effectiveConfig[entry.pluginName],
      ...entry.overrides,
    }
  }
  const sources = profileSources({ workspace: options.workspace, skills: options.skills })
  return {
    profile: createReviewProfile({
      platform: options.platform,
      scope: options.scope,
      config: effectiveConfig,
      skills: selectedSkills,
      pluginConfigs,
    }),
    platform: options.platform,
    scope: options.scope,
    skills: selectedSkills,
    pluginConfigs,
    sources,
  }
}

function groupProfiles(options: {
  workspace: CatalogWorkspace
  declarations: readonly ReviewSkillDeclaration[]
  platform?: ReviewPlatform
  scope?: Scope
  config: ReviewProfileConfig
}): ReviewResolvedProfile[] {
  const filtered = options.declarations.filter((entry) =>
    (options.platform === undefined || entry.platform === options.platform)
    && (options.scope === undefined || entry.scope === options.scope))
  if (filtered.length === 0 && (options.platform !== undefined || options.scope !== undefined)) {
    const requested = [options.platform, options.scope].filter(Boolean).join('/')
    throw new ReviewSelectionError('unsupportedProfile', `The selected target does not support profile ${requested}.`)
  }
  const groups = new Map<string, ReviewSkillDeclaration[]>()
  for (const entry of filtered) {
    const key = `${entry.platform}\0${entry.scope}`
    const group = groups.get(key) ?? []
    if (!group.some((existing) => declarationKey(existing) === declarationKey(entry))) group.push(entry)
    groups.set(key, group)
  }
  return [...groups.entries()].sort(([left], [right]) => compareText(left, right)).map(([key, skills]) => {
    const [platform, scope] = key.split('\0') as [ReviewPlatform, Scope]
    return buildProfile({ workspace: options.workspace, platform, scope, skills, config: options.config })
  })
}

export async function resolveReviewSelection(options: {
  cwd: string
  target: string
  workspaceRoot?: string
  skills?: readonly string[]
  platform?: ReviewPlatform
  scope?: Scope
  configFile?: string
  config?: ReviewProfileConfig
  env?: NodeJS.ProcessEnv
}): Promise<ReviewSelection> {
  void options.env
  if (options.platform !== undefined
    && options.platform !== 'codex'
    && options.platform !== 'claude'
    && options.platform !== 'agent-skills') {
    throw new ReviewSelectionError('invalidArguments', `Unsupported Review platform: ${options.platform}`)
  }
  if (options.scope !== undefined && options.scope !== 'project' && options.scope !== 'user') {
    throw new ReviewSelectionError('invalidArguments', `Unsupported Review scope: ${options.scope}`)
  }
  const skills = uniqueSkillNames(options.skills)
  const { resolution, workspace, candidate } = await resolveWorkspace(options)
  const declarations = await inventorySkills(workspace.plugins)
  const target = await resolveTarget({
    workspace,
    target: options.target,
    candidate,
    skills,
    declarations,
  })
  try {
    const config = await readReviewConfig(options)
    validateConfigPlugins(workspace, config)
    const selected = filterRequestedSkills({ target, declarations, skills })
    const profiles = groupProfiles({
      workspace,
      declarations: selected,
      platform: options.platform,
      scope: options.scope,
      config,
    })
    const sources = [...new Set(profiles.flatMap((profile) => profile.sources))].sort(compareText)
    return {
      workspace,
      workspaceResolvedFrom: resolution.workspaceRootResolvedFrom,
      sourceIdentity: await calculateCatalogWorkspaceSourceIdentity(workspace),
      target,
      profiles,
      sources,
    }
  } catch (error) {
    if (error instanceof ReviewSelectionError) throw error.withTarget(target)
    throw new ReviewSelectionError(
      'invalidArguments',
      error instanceof Error ? error.message : String(error),
    ).withTarget(target)
  }
}

export async function reviewBindingMatchesSelection(options: {
  workspace: CatalogWorkspace
  bindingProfile: ReviewProfile
  requestedProfile: ReviewResolvedProfile
  pluginName: string
  skill: string
}): Promise<boolean> {
  if (
    options.bindingProfile.platform !== options.requestedProfile.platform
    || options.bindingProfile.scope !== options.requestedProfile.scope
  ) return false
  const resolveLeaf = (
    config: ReviewProfileConfig,
  ): ReviewResolvedProfile | null => {
    const declarations = options.requestedProfile.skills.filter((entry) =>
      entry.pluginName === options.pluginName && entry.name === options.skill)
    if (declarations.length === 0) return null
    const withProfile = declarations.map((entry) => ({
      ...entry,
      platform: options.requestedProfile.platform,
      scope: options.requestedProfile.scope,
    }))
    return buildProfile({
      workspace: options.workspace,
      platform: options.requestedProfile.platform,
      scope: options.requestedProfile.scope,
      skills: withProfile,
      config,
    })
  }
  try {
    const bound = resolveLeaf(options.bindingProfile.config)
    const requested = resolveLeaf(options.requestedProfile.profile.config)
    return bound !== null
      && requested !== null
      && bound.profile.inputDigest === requested.profile.inputDigest
  } catch {
    return false
  }
}
