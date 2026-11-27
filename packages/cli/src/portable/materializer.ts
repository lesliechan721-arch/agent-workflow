import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import fs from 'fs-extra';
import { isPlatformTarget, PLATFORM_TARGETS, resolveSupportedPlatforms, validateCatalogPluginClosureComplete, type PlatformTarget } from '@lesliechan721/aw-plugin-core';
import { COMPONENT_KINDS, resolveInvocationPolicy } from '@lesliechan721/aw-plugin-core/manifest';
import { createIsolatedSkillEnv, materializeProfilePluginComponents, prepareSkillPluginBundle, type ComponentPreparationBinding } from '../review/skill-materialization.js';

import { selectPlatformInvocationPolicy } from '../generators/permissions.js';
import type { Diagnostic } from '../output/public-result.js';
import type {
  CatalogGenerationSetSource,
  CatalogManifestV7Entry,
  CatalogSourceResolution,
  PluginMeta,
  PortablePluginRelation,
  PortableSkillCandidate,
  Scope,
} from '../types.js';
import {
  parsePortableSkillFrontmatter,
  validatePortableSkillDirectory,
  type DynamicSkillTree,
} from '../utils/dynamic-skill-tree.js';
import { writePluginConfigStore } from '../utils/plugin-config.js';
import { getAuthoringPlatformCapabilities } from '../review/platform-profile.js';
import { resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js';
import {
  checkAwCapabilitySupport,
  readPluginManifest,
} from '../utils/manifest.js';
import { parsePluginId, withResolvedCatalogPlugin } from '../utils/multi-source-catalog.js';
import { CatalogGenerationError } from '../utils/catalog-generation-error.js';
import { resolveCatalogManifestSourcesForCommit } from '../utils/catalog-generation-resolver.js';
import type { CatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { CatalogPreparationReadScope, type CatalogOperationContext } from '../utils/catalog-operation-context.js';
import type { PreparedArtifactRenderResults } from '../utils/artifact-renderer.js';
import { validateRuntimeSkillClosure } from '../utils/runtime-skill-closure.js';
import {
  AwCapabilityUnsupportedError,
  IMPLEMENTED_AW_CAPABILITIES,
} from '../commands/aw-capabilities.js';
import {
  resolveCatalogSnapshotBindingSource,
  resolvePortablePluginProfileConfig,
  resolvePortableProfileBindingInputs,
  type AwCatalogSnapshotBindingSource,
  type AwSourceBindingProfile,
  type PortablePluginProfileConfig,
} from '../review/source-binding.js';

export interface PortableMaterializationProvenance {
  schemaVersion: 1;
  pluginId: string;
  platform: PlatformTarget;
  scope: Scope;
  dependencyPluginIds: string[];
  configDigest: string;
  digest: string;
  skills: Array<PortableSkillCandidate & { digest: string }>;
}

export interface MaterializePortableSkillsOptions {
  plugins: readonly PluginMeta[];
  pluginId: string;
  platform: PlatformTarget;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  outputRoot?: string;
  signal?: AbortSignal;
  inputMode?: 'source' | 'bundle';
  selectedSkills?: readonly string[];
  includeComponentGaps?: boolean;
  preparedResults?: PreparedArtifactRenderResults;
}

export interface MaterializedPortableSkills {
  rootDir: string;
  pluginId: string;
  sourceId?: string;
  sourceIdentity?: string;
  pluginVersion?: string;
  platform: PlatformTarget;
  scope: Scope;
  candidates: PortableSkillCandidate[];
  dependencyPluginIds: string[];
  configDigest: string;
  digest: string;
  provenancePath: string;
  preparation: ComponentPreparationBinding[];
  sourceBindingSource?: AwCatalogSnapshotBindingSource;
  cleanup(): Promise<void>;
}

export interface MaterializePortableSkillsFromCatalogOptions {
  includeComponentGaps?: boolean;
  preparedResults?: PreparedArtifactRenderResults;
  selector: string;
  platform: PlatformTarget;
  scope: Scope;
  cwd: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  configSnapshot?: CatalogSourcesConfigSnapshot;
  catalogOperationContext?: CatalogOperationContext;
  catalogReadScope?: CatalogPreparationReadScope;
}

interface CandidateTree {
  plugin: PluginMeta;
  relation: PortablePluginRelation;
  dynamic: boolean;
  tree: DynamicSkillTree;
}

export interface PortableCatalogBindingInput {
  source: AwCatalogSnapshotBindingSource;
  subject: { plugin: string };
  profile: AwSourceBindingProfile & { kind: 'portable' };
  /** Read-only configuration evidence; it is not part of the materialization identity. */
  providerConfigs?: ReadonlyArray<readonly [string, string]>;
  policyNotices?: Diagnostic[];
}

export function assertPortablePlatform(platform: unknown): asserts platform is PlatformTarget {
  if (!isPlatformTarget(platform)) {
    throw new Error(`Skill export requires an explicit canonical platform: ${PLATFORM_TARGETS.join(', ')}.`);
  }
}

function pluginId(plugin: PluginMeta): string {
  return plugin.pluginId ?? (plugin.sourceId
    ? `${plugin.sourceId}/${plugin.manifest.name}`
    : plugin.manifest.name);
}

function resolveRequestedPlugin(plugins: readonly PluginMeta[], requestedId: string): PluginMeta {
  const matches = plugins.filter((plugin) =>
    pluginId(plugin) === requestedId || plugin.manifest.name === requestedId);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `Unknown portable plugin "${requestedId}".`
      : `Ambiguous portable plugin "${requestedId}".`);
  }
  return matches[0]!;
}

function assertSameSource(root: PluginMeta, closure: readonly PluginMeta[]): void {
  for (const plugin of closure) {
    if (
      (root.sourceId !== undefined && plugin.sourceId !== root.sourceId)
      || (root.sourceIdentity !== undefined && plugin.sourceIdentity !== root.sourceIdentity)
    ) {
      throw new Error('Portable dependency closure must resolve from one Catalog source.');
    }
  }
}

function relationFor(root: PluginMeta, plugin: PluginMeta): PortablePluginRelation {
  if (plugin.manifest.name === root.manifest.name) return 'requested';
  if ((root.manifest.dependencies ?? []).includes(plugin.manifest.name)) return 'direct';
  return 'transitive';
}

function stableDigest(entries: readonly [string, Buffer][]): string {
  const hash = crypto.createHash('sha256');
  for (const [relativePath, content] of entries) {
    hash.update(relativePath, 'utf8');
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function treeDigest(tree: DynamicSkillTree): string {
  return stableDigest(Object.entries(tree.files).sort(([left], [right]) => left.localeCompare(right)));
}

function skillDescriptions(tree: DynamicSkillTree): Pick<PortableSkillCandidate,
  'description' | 'shortDescription' | 'shortDescriptionSource'> {
  const content = tree.files['SKILL.md']?.toString('utf8') ?? '';
  const frontmatter = parsePortableSkillFrontmatter(content);
  const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
  const metadata = frontmatter.metadata;
  const short = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)['short-description'] : undefined;
  const fromMetadata = typeof short === 'string' && short.trim().length > 0;
  const safe = stripVTControlCharacters(fromMetadata ? short : description)
    .replace(/\s+/gu, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim();
  const sentence = fromMetadata ? safe : safe.match(/^.*?(?:[。！？]|[.!?](?=\s|$)|$)/u)?.[0] ?? safe;
  const points = [...sentence];
  return {
    description,
    shortDescription: points.length > 120 ? `${points.slice(0, 119).join('')}…` : sentence,
    shortDescriptionSource: fromMetadata ? 'metadata' : 'fallback',
  };
}

async function copyTreeFiles(files: Record<string, Buffer>, targetRoot: string): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(targetRoot, ...relativePath.split('/'));
    await fs.ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, content);
  }
}

async function materializePluginCandidates(options: {
  plugins: readonly PluginMeta[];
  plugin: PluginMeta;
  relation: PortablePluginRelation;
  platform: PlatformTarget;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  inputMode: 'source' | 'bundle';
  profileConfig?: PortablePluginProfileConfig;
  selectedSkills?: ReadonlySet<string>;
  includeComponentGaps?: boolean;
  preparedResults?: PreparedArtifactRenderResults;
  recordConfigDigest: (pluginId: string, configDigest: string) => void;
  recordPreparation: (preparation: ComponentPreparationBinding[]) => void;
}): Promise<CandidateTree[]> {
  const profileConfig = options.profileConfig ?? await resolvePortablePluginProfileConfig({ ...options });
  options.recordConfigDigest(pluginId(options.plugin), profileConfig.digest);
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-profile-skills-'));
  try {
    const materialized = await materializeProfilePluginComponents({
      ...options, outputRoot: stagingRoot, kinds: options.includeComponentGaps ? COMPONENT_KINDS : ['skill'], portable: true, config: profileConfig.config,
      selectedSkills: options.selectedSkills ? [...options.selectedSkills] : undefined,
    });
    options.recordPreparation(materialized.preparation.map((unit) => ({ ...unit, outputs: [] })));
    const output: CandidateTree[] = [];
    for (const skill of materialized.skills) {
      const tree = await validatePortableSkillDirectory(skill.path);
      const candidate = { plugin: options.plugin, relation: options.relation, dynamic: skill.dynamic, tree };
      assertNoUnresolvedTemplates(candidate);
      output.push(candidate);
    }
    return output;
  } finally {
    await fs.remove(stagingRoot);
  }
}

function assertNoUnresolvedTemplates(candidate: CandidateTree): void {
  for (const [file, bytes] of Object.entries(candidate.tree.files)) {
    if (/\{\{[^{}]+\}\}/u.test(bytes.toString('utf8'))) {
      throw new Error(`Portable Skill "${candidate.tree.skillKey}" has an unresolved template in ${file}.`);
    }
  }
}

function resolvePortableCatalogClosureEntries(
  source: Pick<CatalogSourceResolution, 'sourceId' | 'manifest'>, pluginName: string,
): CatalogManifestV7Entry[] {
  const entriesByName = new Map(source.manifest.entries.map((entry) => [entry.name, entry]));
  const closure: CatalogManifestV7Entry[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    const entry = entriesByName.get(name);
    if (!entry) throw new Error(`Portable plugin "${name}" is missing from its catalog source.`);
    seen.add(name);
    for (const dependency of entry.dependencies) visit(dependency);
    const support = checkAwCapabilitySupport(
      entry.requires.aw.capabilities ?? [],
      IMPLEMENTED_AW_CAPABILITIES,
    );
    if (!support.supported) {
      throw new AwCapabilityUnsupportedError(`${source.sourceId}/${name}`, support.missing);
    }
    closure.push(entry);
  };
  visit(pluginName);
  return closure;
}

function bindPortableCatalogPlugins(
  source: Pick<CatalogSourceResolution, 'sourceId' | 'sourceIdentity' | 'logicalIdentity'>,
  plugins: PluginMeta[],
): PluginMeta[] {
  for (const plugin of plugins) {
    plugin.sourceId = source.sourceId;
    plugin.sourceIdentity = source.sourceIdentity;
    plugin.catalogLogicalIdentity = source.logicalIdentity;
    plugin.pluginId = `${source.sourceId}/${plugin.manifest.name}`;
  }
  return plugins;
}

async function resolvePortableCatalogPlugins(options: {
  source: CatalogSourceResolution;
  requestedPlugin: PluginMeta;
  catalogReadScope?: CatalogPreparationReadScope;
}): Promise<PluginMeta[]> {
  const closureNames = resolvePortableCatalogClosureEntries(options.source, options.requestedPlugin.manifest.name)
    .map((entry) => entry.name);
  await CatalogPreparationReadScope.validateEntries(options.catalogReadScope, options.source, closureNames);
  const plugins = await Promise.all(closureNames.map((name) => readPluginManifest(
    path.join(options.source.rootDir, 'plugins', name),
    { mode: 'bundle' },
  )));
  return bindPortableCatalogPlugins(options.source, plugins);
}

type PortableBindingOptions = Pick<MaterializePortableSkillsFromCatalogOptions, 'platform' | 'scope' | 'cwd' | 'env'>;
type PortableBindingSource = Pick<CatalogSourceResolution, 'sourceId' | 'sourceIdentity' | 'logicalIdentity' | 'snapshotDigest' | 'rootDir'>;

async function resolvePortableCatalogProfileInput(
  options: PortableBindingOptions,
  source: PortableBindingSource,
  pluginName: string,
  plugins: PluginMeta[],
): Promise<PortableCatalogBindingInput> {
  const inputs = await resolvePortableProfileBindingInputs({
    plugins,
    pluginName,
    platform: options.platform,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    sourceId: source.sourceId,
    catalogSourceIdentity: source.sourceIdentity,
    logicalIdentity: source.logicalIdentity,
  });
  return {
    source: await resolveCatalogSnapshotBindingSource(source),
    subject: { plugin: pluginName },
    profile: inputs.profile,
    providerConfigs: inputs.providerConfigs,
  };
}

/**
 * Preparation already required complete transport validation. At output commit,
 * reacquire control/manifest evidence and independently recheck the consumed
 * dependency closure and its current effective configuration. Return undefined
 * when the current selection no longer matches the prepared generation.
 */
export async function recheckPortableCatalogBindingInput(
  options: PortableBindingOptions & { selector: string; signal?: AbortSignal; preparedSource?: CatalogGenerationSetSource },
): Promise<PortableCatalogBindingInput | undefined> {
  options.signal?.throwIfAborted();
  const selector = parsePluginId(options.selector);
  const prepared = options.preparedSource;
  if (!prepared) return undefined;
  const sources = await resolveCatalogManifestSourcesForCommit({
    ...(selector.sourceId ? { sourceIds: [selector.sourceId] } : {}),
    env: options.env,
    preparedSource: prepared,
  });
  options.signal?.throwIfAborted();
  if (!sources) return undefined;
  const matches = sources.filter((source) => source.manifest.entries.some((entry) => entry.name === selector.pluginName));
  const generation = matches[0];
  // A valid new selection or generation means the prepared review is stale,
  // even when the old subject is now absent or the selector became ambiguous.
  if (matches.length !== 1 || !generation
    || generation.sourceId !== prepared.sourceId
    || generation.sourceIdentity !== prepared.sourceIdentity
    || generation.sourceConfigFingerprint !== prepared.sourceConfigFingerprint
    || generation.logicalIdentity !== prepared.logicalIdentity
    || generation.manifestDigest !== prepared.manifestDigest
    || generation.snapshotDigest !== prepared.snapshotDigest) return undefined;
  const source = { ...generation, rootDir: generation.snapshotPath };
  const entries = resolvePortableCatalogClosureEntries(source, selector.pluginName);
  const plugins = await validateCatalogPluginClosureComplete(source.rootDir, entries).catch((cause: unknown) => {
    throw new CatalogGenerationError({
      code: 'catalogGenerationMetadataInvalid',
      sourceId: source.sourceId,
      message: 'Catalog store snapshot is damaged. Remove the damaged store entry and run aw source sync.',
      cause,
    });
  });
  const bindingInput = await resolvePortableCatalogProfileInput(options, source, selector.pluginName,
    bindPortableCatalogPlugins(source, plugins));
  options.signal?.throwIfAborted();
  return bindingInput;
}

export async function resolvePortableCatalogBindingInput(
  options: MaterializePortableSkillsFromCatalogOptions,
): Promise<PortableCatalogBindingInput> {
  assertPortablePlatform(options.platform);
  return withResolvedCatalogPlugin({
    selector: options.selector,
    cliVersion: options.cliVersion,
    ...(options.env ? { env: options.env } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.configSnapshot ? { configSnapshot: options.configSnapshot } : {}),
    ...(options.catalogReadScope ? { catalogReadScope: options.catalogReadScope } : {}),
    ...(options.catalogOperationContext
      ? { operationContext: options.catalogOperationContext }
      : {}),
    consume: async ({ source, plugin: requestedPlugin }) => {
      const plugins = await resolvePortableCatalogPlugins({ source, requestedPlugin, catalogReadScope: options.catalogReadScope });
      const bindingInput = await resolvePortableCatalogProfileInput(options, source, requestedPlugin.manifest.name, plugins);
      return {
        ...bindingInput,
        ...(options.platform === 'generic' ? { policyNotices: plugins.flatMap((plugin) =>
          selectPlatformInvocationPolicy(resolveInvocationPolicy(plugin.manifest, options.platform), {
            pluginId: pluginId(plugin), target: options.platform, scope: options.scope,
          }).diagnostics) } : {}),
      };
    },
  });
}

export async function materializePortableSkillsFromCatalog(
  options: MaterializePortableSkillsFromCatalogOptions,
): Promise<MaterializedPortableSkills> {
  assertPortablePlatform(options.platform);
  const operationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-portable-operation-'));
  const outputRoot = path.join(operationRoot, 'materialized');
  try {
    const metadata = await withResolvedCatalogPlugin({
      selector: options.selector,
      cliVersion: options.cliVersion,
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.configSnapshot ? { configSnapshot: options.configSnapshot } : {}),
      ...(options.catalogReadScope ? { catalogReadScope: options.catalogReadScope } : {}),
      ...(options.catalogOperationContext
        ? { operationContext: options.catalogOperationContext }
        : {}),
      consume: async ({ pluginId: resolvedPluginId, source, plugin: requestedPlugin }) => {
        const plugins = await resolvePortableCatalogPlugins({ source, requestedPlugin, catalogReadScope: options.catalogReadScope });
        const materialized = await materializePortableSkills({
          plugins,
          pluginId: resolvedPluginId,
          platform: options.platform,
          scope: options.scope,
          cwd: options.cwd,
          env: options.env,
          outputRoot,
          signal: options.signal,
          inputMode: 'bundle',
          includeComponentGaps: options.includeComponentGaps,
          preparedResults: options.preparedResults,
        });
        return {
          pluginId: materialized.pluginId,
          sourceId: source.sourceId,
          sourceIdentity: source.sourceIdentity,
          pluginVersion: requestedPlugin.manifest.version,
          platform: materialized.platform,
          scope: materialized.scope,
          preparation: materialized.preparation,
          candidates: materialized.candidates,
          dependencyPluginIds: materialized.dependencyPluginIds,
          configDigest: materialized.configDigest,
          digest: materialized.digest,
          sourceBindingSource: await resolveCatalogSnapshotBindingSource(source),
        };
      },
    });
    return {
      ...metadata,
      rootDir: outputRoot,
      provenancePath: path.join(outputRoot, '.aw-materialization.json'),
      cleanup: async () => fs.remove(operationRoot),
    };
  } catch (error) {
    await fs.remove(operationRoot);
    throw error;
  }
}

export async function materializePortableSkills(
  options: MaterializePortableSkillsOptions,
): Promise<MaterializedPortableSkills> {
  assertPortablePlatform(options.platform);
  const requested = resolveRequestedPlugin(options.plugins, options.pluginId);
  if (!resolveSupportedPlatforms(requested.manifest).has(options.platform)) {
    throw new Error(`Plugin "${pluginId(requested)}" does not support platform "${options.platform}".`);
  }
  const closure = resolvePluginMetaDependencyClosure(options.plugins, [requested.manifest.name]);
  assertSameSource(requested, closure);
  for (const plugin of closure) {
    if (!resolveSupportedPlatforms(plugin.manifest).has(options.platform)) {
      throw new Error(`Portable dependency "${pluginId(plugin)}" does not support platform "${options.platform}".`);
    }
  }
  const createdRoot = options.outputRoot === undefined;
  const rootDir = options.outputRoot
    ? path.resolve(options.outputRoot)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'aw-portable-materialize-'));
  if (options.outputRoot) {
    if (await fs.pathExists(rootDir)) {
      throw new Error(`Portable output root already exists: ${rootDir}.`);
    }
    await fs.ensureDir(rootDir);
  }
  const skillsRoot = path.join(rootDir, 'skills');
  const profileConfigs = await Promise.all(closure.map(async (plugin) => ({
    plugin,
    config: await resolvePortablePluginProfileConfig({ ...options, plugin, env: options.env ?? process.env }),
  })));
  const env = await createIsolatedSkillEnv(options.env ?? process.env, path.join(rootDir, '.environment'));
  for (const { plugin, config } of profileConfigs) {
    await writePluginConfigStore({
      sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity,
      pluginName: plugin.manifest.name, platform: options.platform, scope: options.scope,
      cwd: options.cwd, env, values: config.config.values,
    });
  }
  try {
    const trees: CandidateTree[] = [];
    const configDigests: Array<[string, string]> = [];
    const preparation: ComponentPreparationBinding[] = [];
    const selectedSkills = options.selectedSkills
      ? new Set(options.selectedSkills)
      : undefined;
    if (selectedSkills?.size !== options.selectedSkills?.length) {
      throw new Error('Portable Skill selection contains duplicate names.');
    }
    for (const plugin of closure) {
      options.signal?.throwIfAborted();
      if (selectedSkills && plugin.manifest.name !== requested.manifest.name) continue;
      const prepared = options.inputMode === 'bundle' ? undefined : await prepareSkillPluginBundle({
        plugin, plugins: options.plugins, workRoot: path.join(rootDir, '.prepare'), env,
      });
      try {
        const candidatePlugin = prepared?.bundlePlugin ?? plugin;
        trees.push(...await materializePluginCandidates({
          plugins: options.plugins.map((entry) => entry === plugin ? candidatePlugin : entry),
          plugin: candidatePlugin,
          relation: relationFor(requested, plugin),
          platform: options.platform,
          scope: options.scope,
          cwd: options.cwd,
          env,
          signal: options.signal,
          inputMode: 'bundle',
          includeComponentGaps: options.includeComponentGaps,
          preparedResults: options.preparedResults,
          profileConfig: profileConfigs.find((entry) => entry.plugin.manifest.name === plugin.manifest.name)!.config,
          ...(selectedSkills ? { selectedSkills } : {}),
          recordConfigDigest: (id, configDigest) => configDigests.push([id, configDigest]),
          recordPreparation: (entries) => preparation.push(...entries),
        }));
      } finally {
        await prepared?.cleanup();
      }
    }
    await fs.remove(path.join(rootDir, '.prepare'));
    await fs.remove(path.join(rootDir, '.environment'));
    if (selectedSkills) {
      const materializedNames = new Set(trees.map((candidate) => candidate.tree.skillKey));
      const missing = [...selectedSkills]
        .filter((skill) => !materializedNames.has(skill))
        .sort((left, right) => left.localeCompare(right));
      if (missing.length > 0) {
        throw new Error(`Selected portable Skills were not materialized: ${missing.join(', ')}.`);
      }
    }
    const seenNames = new Set<string>();
    for (const candidate of trees) {
      if (seenNames.has(candidate.tree.skillKey)) {
        throw new Error(`Portable Skill name collision: "${candidate.tree.skillKey}".`);
      }
      seenNames.add(candidate.tree.skillKey);
      await copyTreeFiles(candidate.tree.files, path.join(skillsRoot, candidate.tree.skillKey));
      await validateRuntimeSkillClosure(path.join(skillsRoot, candidate.tree.skillKey));
    }
    const candidates = trees.map((candidate): PortableSkillCandidate => ({
      name: candidate.tree.skillKey,
      ...skillDescriptions(candidate.tree),
      providerPluginId: pluginId(candidate.plugin),
      providerDisplayName: candidate.plugin.manifest.interface?.displayName
        ?? candidate.plugin.manifest.name,
      relation: candidate.relation,
      dynamic: candidate.dynamic,
      filesDigest: treeDigest(candidate.tree),
      configDigest: new Map(configDigests).get(pluginId(candidate.plugin)),
    })).sort((left, right) => left.name.localeCompare(right.name));
    const dependencyPluginIds = closure
      .filter((plugin) => plugin.manifest.name !== requested.manifest.name)
      .map(pluginId);
    const configDigest = `sha256:${crypto.createHash('sha256')
      .update(JSON.stringify({ platform: options.platform, scope: options.scope, capabilities: getAuthoringPlatformCapabilities(options.platform, options.scope, { portable: true }), config: configDigests }))
      .digest('hex')}`;
    const digest = `sha256:${crypto.createHash('sha256')
      .update(JSON.stringify({ platform: options.platform, scope: options.scope, skills: candidates.map((candidate) => [candidate.name, candidate.filesDigest]) }))
      .digest('hex')}`;
    const provenancePath = path.join(rootDir, '.aw-materialization.json');
    const provenance: PortableMaterializationProvenance = {
      schemaVersion: 1,
      pluginId: pluginId(requested),
      platform: options.platform,
      scope: options.scope,
      dependencyPluginIds,
      configDigest,
      digest,
      skills: candidates.map((candidate) => ({ ...candidate, digest: candidate.filesDigest })),
    };
    await fs.writeJson(provenancePath, provenance, { spaces: 2 });
    return {
      rootDir,
      pluginId: pluginId(requested),
      platform: options.platform,
      scope: options.scope,
      candidates,
      dependencyPluginIds,
      configDigest,
      digest,
      provenancePath,
      preparation,
      cleanup: async () => {
        if (createdRoot) await fs.remove(rootDir);
      },
    };
  } catch (error) {
    await fs.remove(rootDir);
    throw error;
  }
}
