import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { canonicalizePluginConfigValues } from '@lesliechan721/aw-plugin-core/manifest';

import type {
  ArtifactRuntimeImportDefinition,
  PluginMeta,
  PortablePluginRelation,
  PortableSkillCandidate,
  Scope,
} from '../types.js';
import { validateArtifactPlan } from '../utils/artifact-plan.js';
import { runArtifactRenderer, resolveArtifactRenderConfig } from '../utils/artifact-renderer.js';
import { calculateFileDigest } from '../utils/bundle-integrity.js';
import {
  AW_PLUGIN_REQUIREMENTS_RECEIPT_PATH,
  parsePortableSkillFrontmatter,
  validatePortableSkillDirectory,
  type DynamicSkillTree,
} from '../utils/dynamic-skill-tree.js';
import { resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js';
import {
  createAwPluginRequirementsReceipt,
  parseAwPluginRequirementsReceipt,
  checkAwCapabilitySupport,
  readPluginManifest,
} from '../utils/manifest.js';
import { withResolvedCatalogPlugin } from '../utils/multi-source-catalog.js';
import type { CatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import type { CatalogOperationContext } from '../utils/catalog-operation-context.js';
import { collectSensitivePluginConfigValues } from '../utils/plugin-scripts.js';
import { validateRuntimeSkillClosure } from '../utils/runtime-skill-closure.js';
import { isSkillAuthorOnlyPath } from '../utils/skill-authoring.js';
import { validateCatalogSnapshotPluginEntriesComplete } from '../utils/catalog-snapshot.js';
import {
  AwCapabilityUnsupportedError,
  IMPLEMENTED_AW_CAPABILITIES,
} from '../commands/aw-capabilities.js';

export interface PortableMaterializationProvenance {
  schemaVersion: 1;
  pluginId: string;
  scope: Scope;
  dependencyPluginIds: string[];
  configDigest: string;
  digest: string;
  skills: Array<PortableSkillCandidate & { digest: string }>;
}

export interface MaterializePortableSkillsOptions {
  plugins: readonly PluginMeta[];
  pluginId: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  outputRoot?: string;
  signal?: AbortSignal;
  inputMode?: 'source' | 'bundle';
}

export interface MaterializedPortableSkills {
  rootDir: string;
  pluginId: string;
  sourceId?: string;
  sourceIdentity?: string;
  pluginVersion?: string;
  scope: Scope;
  candidates: PortableSkillCandidate[];
  dependencyPluginIds: string[];
  configDigest: string;
  digest: string;
  provenancePath: string;
  cleanup(): Promise<void>;
}

export interface MaterializePortableSkillsFromCatalogOptions {
  selector: string;
  scope: Scope;
  cwd: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  configSnapshot?: CatalogSourcesConfigSnapshot;
  catalogOperationContext?: CatalogOperationContext;
}

interface CandidateTree {
  plugin: PluginMeta;
  relation: PortablePluginRelation;
  dynamic: boolean;
  tree: DynamicSkillTree;
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

function skillDescription(tree: DynamicSkillTree): string {
  const content = tree.files['SKILL.md']?.toString('utf8') ?? '';
  const frontmatter = parsePortableSkillFrontmatter(content);
  return typeof frontmatter.description === 'string' ? frontmatter.description : '';
}

async function copyTreeFiles(files: Record<string, Buffer>, targetRoot: string): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(targetRoot, ...relativePath.split('/'));
    await fs.ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, content);
  }
}

async function overlayDirectory(
  sourceRoot: string,
  files: Record<string, Buffer>,
): Promise<void> {
  const visit = async (current: string, parent = ''): Promise<void> => {
    const stats = await fs.lstat(current).catch(() => undefined);
    if (!stats?.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Portable Skill source must be a regular directory: ${sourceRoot}.`);
    }
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
      if (isSkillAuthorOnlyPath(relativePath)) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Portable Skill source contains a symbolic link: ${relativePath}.`);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files[relativePath] = await fs.readFile(absolutePath);
      } else {
        throw new Error(`Portable Skill source contains a non-regular file: ${relativePath}.`);
      }
    }
  };
  await visit(sourceRoot);
}

function assertNoSensitiveValues(
  candidate: CandidateTree,
  sensitiveValues: readonly string[],
): void {
  for (const [relativePath, content] of Object.entries(candidate.tree.files)) {
    const text = content.toString('utf8');
    if (/\{\{[^{}]+\}\}/u.test(text)) {
      throw new Error(`Portable Skill "${candidate.tree.skillKey}" contains an unresolved template in "${relativePath}".`);
    }
    const leaked = sensitiveValues.find((value) => value.length > 0 && text.includes(value));
    if (leaked) {
      throw new Error(`Portable Skill "${candidate.tree.skillKey}" exposes sensitive config in "${relativePath}".`);
    }
  }
}

async function assertRuntimeImports(plugin: PluginMeta): Promise<void> {
  const imports = (plugin.manifest.artifacts?.targets ?? [])
    .filter((target) => target.distribution === 'agent-skills')
    .flatMap((target) => target.runtimeImports ?? []);
  for (const runtimeImport of imports) {
    await assertRuntimeImport(plugin, runtimeImport);
  }
}

async function assertRuntimeImport(
  plugin: PluginMeta,
  runtimeImport: ArtifactRuntimeImportDefinition,
): Promise<void> {
  if (!runtimeImport.resolved) {
    throw new Error(`Artifact runtime import "${runtimeImport.name}" is not resolved in the consumer bundle.`);
  }
  const root = await fs.realpath(plugin.rootDir);
  const importPath = path.join(root, runtimeImport.resolved.path.replace(/^\.\//u, ''));
  const stats = await fs.lstat(importPath).catch(() => undefined);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Artifact runtime import "${runtimeImport.name}" is missing from the consumer bundle.`);
  }
  const realImport = await fs.realpath(importPath);
  const relative = path.relative(root, realImport);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Artifact runtime import "${runtimeImport.name}" escapes the consumer bundle.`);
  }
  if (await calculateFileDigest(realImport) !== runtimeImport.resolved.digest) {
    throw new Error(`Artifact runtime import "${runtimeImport.name}" has an invalid digest.`);
  }
}

async function materializePluginCandidates(options: {
  plugin: PluginMeta;
  relation: PortablePluginRelation;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  inputMode: 'source' | 'bundle';
  recordConfigDigest: (pluginId: string, configDigest: string) => void;
}): Promise<CandidateTree[]> {
  options.signal?.throwIfAborted();
  const distribution = options.plugin.manifest.distributions?.agentSkills;
  if (!distribution) return [];
  const dynamicTargets = (options.plugin.manifest.artifacts?.targets ?? [])
    .filter((target) =>
      target.distribution === 'agent-skills'
      && target.scopes.includes(options.scope));
  const dynamicKeys = new Set((options.plugin.manifest.artifacts?.targets ?? [])
    .filter((target) => target.target === 'agent-skills.skill')
    .map((target) => target.skillKey!));
  const output: CandidateTree[] = [];
  const config = await resolveArtifactRenderConfig({
    sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity,
    logicalIdentity: options.plugin.catalogLogicalIdentity,
    pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });
  if (config.issues.length > 0) {
    throw new Error(`Portable materialization config is invalid: ${config.issues.map((issue) => issue.message).join('; ')}`);
  }
  options.recordConfigDigest(
    pluginId(options.plugin),
    `sha256:${crypto.createHash('sha256')
      .update(JSON.stringify(canonicalizePluginConfigValues(config.values)))
      .digest('hex')}`,
  );
  const staticRoot = distribution.skills
    ? path.join(options.plugin.rootDir, distribution.skills.replace(/^\.\//u, ''))
    : undefined;

  if (staticRoot) {
    const rootStats = await fs.lstat(staticRoot).catch(() => undefined);
    if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error('Portable Skills root must be a regular directory.');
    }
    const entries = await fs.readdir(staticRoot, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryStats = await fs.lstat(path.join(staticRoot, entry.name)).catch(() => undefined);
      if (!entryStats?.isDirectory() || entryStats.isSymbolicLink()) {
        throw new Error(`Portable Skills root direct child must be a regular directory: ${entry.name}.`);
      }
      if (dynamicKeys.has(entry.name)) continue;
      output.push({
        plugin: options.plugin,
        relation: options.relation,
        dynamic: false,
        tree: await validatePortableSkillDirectory(path.join(staticRoot, entry.name)),
      });
    }
  }

  const finalizeCandidates = (): CandidateTree[] => {
    const sensitiveValues = collectSensitivePluginConfigValues(options.plugin.manifest, config.values);
    const receipt = createAwPluginRequirementsReceipt(
      { name: options.plugin.manifest.name, version: options.plugin.manifest.version },
      options.plugin.manifest.requires?.aw.capabilities ?? [],
    );
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    for (const candidate of output) {
      const existingReceipt = candidate.tree.files[AW_PLUGIN_REQUIREMENTS_RECEIPT_PATH];
      if (existingReceipt && options.inputMode !== 'bundle') {
        throw new Error(
          `Portable Skill "${candidate.tree.skillKey}" cannot declare reserved file "${AW_PLUGIN_REQUIREMENTS_RECEIPT_PATH}".`,
        );
      }
      if (existingReceipt) {
        let parsedReceipt: ReturnType<typeof parseAwPluginRequirementsReceipt>;
        try {
          parsedReceipt = parseAwPluginRequirementsReceipt(JSON.parse(existingReceipt.toString('utf8')));
        } catch {
          throw new Error(
            `Portable Skill "${candidate.tree.skillKey}" has an invalid reserved requirements receipt.`,
          );
        }
        if (JSON.stringify(parsedReceipt) !== JSON.stringify(receipt)) {
          throw new Error(
            `Portable Skill "${candidate.tree.skillKey}" has a mismatched reserved requirements receipt.`,
          );
        }
      } else {
        candidate.tree.files[AW_PLUGIN_REQUIREMENTS_RECEIPT_PATH] = receiptBytes;
      }
      assertNoSensitiveValues(candidate, sensitiveValues);
    }
    return output;
  };

  if (dynamicTargets.length === 0) {
    return finalizeCandidates();
  }
  await assertRuntimeImports(options.plugin);
  const rendered = await runArtifactRenderer({
    event: 'materialize',
    plugin: options.plugin,
    platform: 'agent-skills',
    scope: options.scope,
    cwd: options.cwd,
    commandEnv: options.env,
    signal: options.signal,
    requestedArtifactIds: dynamicTargets.map((target) => target.id),
  });
  const plan = validateArtifactPlan({
    pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest,
    plan: rendered.plan,
    platform: 'agent-skills',
    scope: options.scope,
    requestedArtifactIds: rendered.context.requestedArtifactIds,
    renderConfig: config,
    rendererDigest: rendered.target.rendererDigest,
    manifestDigest: rendered.target.manifestDigest,
  });
  const sourcesById = new Map(rendered.context.artifactSources.map((source) => [source.id, source]));
  const portableRuntimeProjectionPath = path.join(
    options.plugin.rootDir,
    '.agents-plugin',
    'portable-runtime-files.json',
  );
  const portableRuntimeProjections = await fs.readJson(portableRuntimeProjectionPath)
    .catch(() => []) as Array<{ skill: string; target: string; path: string; digest: string }>;
  for (const artifact of plan.artifacts) {
    if (artifact.target !== 'agent-skills.skill' || artifact.state === 'disabled') continue;
    const files: Record<string, Buffer> = {};
    for (const sourceDir of sourcesById.get(artifact.id)?.sourceDirs ?? []) {
      await overlayDirectory(sourceDir, files);
    }
    for (const projection of portableRuntimeProjections.filter((entry) =>
      entry.skill === artifact.skillKey)) {
      const expectedPath = `./agent-skills/skills/${artifact.skillKey}/${projection.target}`;
      if (
        projection.path !== expectedPath
        || projection.target.includes('\\')
        || path.posix.normalize(projection.target) !== projection.target
        || !/^(?:references|assets|scripts)\/.+/u.test(projection.target)
      ) {
        throw new Error(`Portable runtime projection "${artifact.skillKey}/${projection.target}" has an invalid bundle path.`);
      }
      const projectionPath = path.join(options.plugin.rootDir, projection.path.replace(/^\.\//u, ''));
      if (await calculateFileDigest(projectionPath) !== projection.digest) {
        throw new Error(`Portable runtime projection "${artifact.skillKey}/${projection.target}" has an invalid digest.`);
      }
      files[projection.target] = await fs.readFile(projectionPath);
    }
    for (const [relativePath, content] of Object.entries(artifact.content?.files ?? {})) {
      if (isSkillAuthorOnlyPath(relativePath)) {
        throw new Error(
          `Portable dynamic Skill "${artifact.skillKey}" renderer returned author-only path "${relativePath}".`,
        );
      }
      if (relativePath === AW_PLUGIN_REQUIREMENTS_RECEIPT_PATH) {
        throw new Error(`Portable dynamic Skill renderer cannot declare reserved file "${AW_PLUGIN_REQUIREMENTS_RECEIPT_PATH}".`);
      }
      files[relativePath] = Buffer.from(content, 'utf8');
    }
    const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-portable-tree-'));
    try {
      const skillRoot = path.join(stagingRoot, artifact.skillKey);
      await copyTreeFiles(files, skillRoot);
      output.push({
        plugin: options.plugin,
        relation: options.relation,
        dynamic: true,
        tree: await validatePortableSkillDirectory(skillRoot),
      });
    } finally {
      await fs.remove(stagingRoot);
    }
  }
  return finalizeCandidates();
}

export async function materializePortableSkillsFromCatalog(
  options: MaterializePortableSkillsFromCatalogOptions,
): Promise<MaterializedPortableSkills> {
  const operationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-portable-operation-'));
  const outputRoot = path.join(operationRoot, 'materialized');
  try {
    const metadata = await withResolvedCatalogPlugin({
      selector: options.selector,
      cliVersion: options.cliVersion,
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.configSnapshot ? { configSnapshot: options.configSnapshot } : {}),
      ...(options.catalogOperationContext
        ? { operationContext: options.catalogOperationContext }
        : {}),
      consume: async ({ pluginId: resolvedPluginId, source, plugin: requestedPlugin }) => {
        const entriesByName = new Map(source.manifest.entries.map((entry) => [entry.name, entry]));
        const closureNames: string[] = [];
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
          closureNames.push(name);
        };
        visit(requestedPlugin.manifest.name);
        await validateCatalogSnapshotPluginEntriesComplete(source.rootDir, closureNames);
        const plugins = await Promise.all(closureNames.map((name) => readPluginManifest(
          path.join(source.rootDir, 'plugins', name),
          { mode: 'bundle' },
        )));
        for (const plugin of plugins) {
          plugin.sourceId = source.sourceId;
          plugin.sourceIdentity = source.sourceIdentity;
          plugin.catalogLogicalIdentity = source.logicalIdentity;
          plugin.pluginId = `${source.sourceId}/${plugin.manifest.name}`;
        }
        const materialized = await materializePortableSkills({
          plugins,
          pluginId: resolvedPluginId,
          scope: options.scope,
          cwd: options.cwd,
          env: options.env,
          outputRoot,
          signal: options.signal,
          inputMode: 'bundle',
        });
        return {
          pluginId: materialized.pluginId,
          sourceId: source.sourceId,
          sourceIdentity: source.sourceIdentity,
          pluginVersion: requestedPlugin.manifest.version,
          scope: materialized.scope,
          candidates: materialized.candidates,
          dependencyPluginIds: materialized.dependencyPluginIds,
          configDigest: materialized.configDigest,
          digest: materialized.digest,
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
  const requested = resolveRequestedPlugin(options.plugins, options.pluginId);
  if (!requested.manifest.distributions?.agentSkills) {
    throw new Error(`Plugin "${pluginId(requested)}" does not declare distributions.agentSkills.`);
  }
  const closure = resolvePluginMetaDependencyClosure(options.plugins, [requested.manifest.name]);
  assertSameSource(requested, closure);
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
  const env = options.env ?? process.env;
  try {
    const trees: CandidateTree[] = [];
    const configDigests: Array<[string, string]> = [];
    for (const plugin of closure) {
      options.signal?.throwIfAborted();
      trees.push(...await materializePluginCandidates({
        plugin,
        relation: relationFor(requested, plugin),
        scope: options.scope,
        cwd: options.cwd,
        env,
        signal: options.signal,
        inputMode: options.inputMode ?? 'source',
        recordConfigDigest: (id, configDigest) => configDigests.push([id, configDigest]),
      }));
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
      description: skillDescription(candidate.tree),
      providerPluginId: pluginId(candidate.plugin),
      providerDisplayName: candidate.plugin.manifest.interface?.displayName
        ?? candidate.plugin.manifest.name,
      relation: candidate.relation,
      dynamic: candidate.dynamic,
      filesDigest: treeDigest(candidate.tree),
    })).sort((left, right) => left.name.localeCompare(right.name));
    const dependencyPluginIds = closure
      .filter((plugin) => plugin.manifest.name !== requested.manifest.name)
      .map(pluginId);
    const configDigest = `sha256:${crypto.createHash('sha256')
      .update(JSON.stringify(configDigests))
      .digest('hex')}`;
    const digest = `sha256:${crypto.createHash('sha256')
      .update(JSON.stringify(candidates.map((candidate) => [candidate.name, candidate.filesDigest])))
      .digest('hex')}`;
    const provenancePath = path.join(rootDir, '.aw-materialization.json');
    const provenance: PortableMaterializationProvenance = {
      schemaVersion: 1,
      pluginId: pluginId(requested),
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
      scope: options.scope,
      candidates,
      dependencyPluginIds,
      configDigest,
      digest,
      provenancePath,
      cleanup: async () => {
        if (createdRoot) await fs.remove(rootDir);
      },
    };
  } catch (error) {
    await fs.remove(rootDir);
    throw error;
  }
}
