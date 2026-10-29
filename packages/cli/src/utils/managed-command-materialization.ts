import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import {
  getCommandPackageId,
  getManagedCommandArtifactTargets,
  getPluginCommandId,
  normalizeProducerIdentity,
  normalizeCommandRelativeFile,
  replaceManagedCommandPlaceholders,
  validateCommandEntryFiles,
  type ManagedCommandProducerRef,
  type ManagedCommandReference,
  type ProducerIdentity,
  type CommandDefinition,
} from '@lesliechan721/aw-plugin-core/manifest';

import type { CommandProducerResult, PlatformName, PluginMeta, ReceiptTargetIdentity, Scope } from '../types.js';
import { resolveArtifactRenderConfig, runArtifactRenderer } from './artifact-renderer.js';
import { resolveCommandSourceDirectory } from './artifact-sources.js';
import { validateArtifactPlan, type ValidatedArtifactPlanArtifact } from './artifact-plan.js';
import type { DynamicSkillTree } from './dynamic-skill-tree.js';
import {
  inspectManagedCommand,
  listManagedCommandPackages,
  listManagedCommands,
  managedCommandDiagnostic,
  ManagedCommandError,
  readInstalledCommandProducer,
  syncManagedCommandPackage,
  validateManagedCommandResource,
  type InstalledCommandSet,
} from './managed-command-store.js';
import { resolveCanonicalRepoProjectKey } from './state-paths.js';
import { validateManagedCommandPackageClosure } from './managed-command-closure.js';
import { isSkillAuthorOnlyPath } from './skill-authoring.js';
import { AW_RUNTIME_CONFIG_BINDING_PATH, AW_RUNTIME_CONFIG_READER_PATH, AW_RUNTIME_NATIVE_RECEIPT_PATH } from '@lesliechan721/aw-plugin-core';

export interface ManagedCommandCandidate {
  producer: ProducerIdentity;
  sets: InstalledCommandSet[];
}

export interface PreparedManagedCommandPackage extends ManagedCommandCandidate {
  resourceRoot: string;
  cleanup(): Promise<void>;
}

export interface ManagedCommandPackageDiscovery {
  packages: Array<{ producer: ProducerIdentity; packageId: string; packageKey: string; refreshKeys: string[]; declared: boolean; installed: boolean }>;
  errors: Array<{ code: string; message: string; subject?: string }>;
}

export interface RetainedManagedCommandPackage {
  producer: ProducerIdentity;
  packageId: string;
  commandIds: string[];
  availability: 'ready' | 'empty' | 'unavailable';
  errors: CommandProducerResult['errors'];
  recoveryAction: string;
}

export async function discoverRetainedManagedCommandPackages(options: {
  selectors: readonly { sourceId?: string; pluginName: string }[];
  all?: boolean; scope: Scope; cwd: string; env: NodeJS.ProcessEnv;
}): Promise<RetainedManagedCommandPackage[]> {
  const listed = await listManagedCommandPackages(options.env).catch(() => ({ packages: [], errors: [] }));
  const selected = listed.packages.filter(({ producer }) => options.all === true || options.selectors.some((selector) =>
    selector.pluginName === producer.pluginName && selector.sourceId === producer.sourceId));
  let projectRoot: string | undefined;
  if (options.scope === 'project' && selected.some(({ producer }) => producer.scope === 'project')) {
    projectRoot = path.normalize(await fs.realpath(await resolveCanonicalRepoProjectKey(options.cwd)));
    if (process.platform === 'win32') projectRoot = projectRoot.replace(/^[a-z]:/u, (drive) => drive.toUpperCase());
  }
  return selected.filter(({ producer }) => producer.scope === 'user'
    || (options.scope === 'project' && producer.projectRoot === projectRoot)).map((entry) => ({
      producer: entry.producer, packageId: entry.id, commandIds: entry.sets.flatMap((set) => set.commandIds),
      availability: entry.availability, errors: entry.errors,
      recoveryAction: `aw command package remove ${entry.id} --yes`,
    }));
}

export function retainedManagedCommandPackageResult(entry: RetainedManagedCommandPackage): CommandProducerResult {
  return { producer: entry.producer,
    state: entry.availability === 'unavailable' ? 'partial' : 'completed', commandIds: entry.commandIds,
    removedCommandIds: [], errors: entry.errors, recoveryActions: [entry.recoveryAction] };
}

export async function prepareManagedCommandPackageFiles(options: {
  sourceRoot: string; files: Record<string, string>; entries: readonly CommandDefinition[];
}): Promise<{ resourceRoot: string; cleanup(): Promise<void> }> {
  await validateManagedCommandResource(options.sourceRoot);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-command-package-'));
  const resourceRoot = path.join(tempRoot, 'resource');
  try {
    await fs.copy(options.sourceRoot, resourceRoot, { dereference: false, errorOnExist: true });
    for (const [relative, content] of Object.entries(options.files)) {
      normalizeCommandRelativeFile(relative, 'command package generated file');
      if (isSkillAuthorOnlyPath(relative) || relative.split('/').some((segment) => ['.git', 'node_modules', '.agents-plugin', '.codex-plugin', '.claude-plugin', '.release', '.tmp', 'evals', 'reports', '.aw-command-producer.json', '.agent-workflows-owner.json', 'owner.json', 'aw-plugin-requirements.json'].includes(segment)) || [AW_RUNTIME_CONFIG_BINDING_PATH, AW_RUNTIME_CONFIG_READER_PATH, AW_RUNTIME_NATIVE_RECEIPT_PATH].includes(relative) || options.entries.some((entry) => entry.entry === relative)) throw new ManagedCommandError('commandResourceInvalid', 'Generated files cannot replace protected resources or command entries.');
      const destination = path.join(resourceRoot, ...relative.split('/'));
      const existing = await fs.lstat(destination).catch(() => null);
      if (existing && !existing.isFile()) throw new ManagedCommandError('commandResourceInvalid', 'A generated file conflicts with a directory.');
      if (existing && ((existing.mode & 0o111) !== 0 || /\.(?:[cm]?js|[cm]?ts|sh|bash|zsh|py|rb|exe|com|cmd|bat|ps1)$/iu.test(relative))) throw new ManagedCommandError('commandResourceInvalid', 'Generated configuration cannot replace executable code.');
      await fs.ensureDir(path.dirname(destination));
      await fs.writeFile(destination, content, { mode: 0o600 });
      await fs.chmod(destination, 0o600);
    }
    for (const reserved of ['.aw-command-producer.json', '.agent-workflows-owner.json', 'owner.json']) {
      if (await fs.pathExists(path.join(resourceRoot, reserved))) throw new ManagedCommandError('commandResourceInvalid', 'The package source contains an AW reserved resource.');
    }
    await validateManagedCommandResource(resourceRoot);
    await validateCommandEntryFiles(resourceRoot, options.entries);
    await validateManagedCommandPackageClosure(resourceRoot, options.entries);
    for (const entry of options.entries) await validateManagedCommandResource(resourceRoot, entry);
    return { resourceRoot, cleanup: () => fs.remove(tempRoot) };
  } catch (error) { await fs.remove(tempRoot); throw error; }
}

function sameProducer(left: ProducerIdentity, right: ProducerIdentity): boolean {
  return getCommandPackageId(left) === getCommandPackageId(right);
}

export async function managedCommandProducerIdentity(options: {
  plugin: PluginMeta; producer: ManagedCommandProducerRef; platform?: PlatformName; scope: Scope; cwd: string;
}): Promise<ProducerIdentity> {
  const { plugin, producer } = options;
  if (!plugin.sourceId || !plugin.sourceIdentity) throw new Error('commandReferenceInvalid: managed commands require verified source identity.');
  let scope = options.scope;
  let platform = options.platform ?? null;
  let key: string;
  if (producer.kind === 'package') {
    const declaration = plugin.manifest.managedCommands?.packages.find((entry) => entry.key === producer.packageKey);
    if (!declaration) throw new Error('commandReferenceInvalid: command package is not declared.');
    key = declaration.key;
    scope = declaration.scope;
    platform = null;
  } else if (producer.kind === 'static-skill') {
    key = producer.skillKey;
    platform = producer.platform;
    scope = 'user';
  } else {
    key = producer.artifactId;
    const declaration = plugin.manifest.artifacts?.targets?.find((entry) => entry.id === producer.artifactId);
    if (!declaration?.platform) throw new Error('commandReferenceInvalid: command artifact is not declared.');
    platform = declaration.platform;
    if (declaration.delivery?.mode === 'codex-native') scope = 'user';
  }
  let projectRoot: string | null = null;
  if (scope === 'project') {
    projectRoot = path.normalize(await fs.realpath(await resolveCanonicalRepoProjectKey(options.cwd)));
    if (process.platform === 'win32') projectRoot = projectRoot.replace(/^[a-z]:/u, (drive) => drive.toUpperCase());
  }
  return normalizeProducerIdentity({ sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginName: plugin.manifest.name, kind: producer.kind, key, platform, scope, projectRoot });
}

export function commandSetsForProducer(options: {
  plugin: PluginMeta; producer: ManagedCommandProducerRef; artifacts?: readonly ValidatedArtifactPlanArtifact[];
  requestedSetNames?: ReadonlySet<string>;
  previousSets?: readonly InstalledCommandSet[];
}): InstalledCommandSet[] {
  const requested = (options.plugin.manifest.managedCommands?.sets ?? []).filter((set) =>
    JSON.stringify(set.producer) === JSON.stringify(options.producer)
    && (options.requestedSetNames === undefined || options.requestedSetNames.has(set.set))).map((set): InstalledCommandSet => {
      if (set.mode === 'static') return { set: set.set, state: 'present', entries: set.entries };
      const artifact = options.artifacts?.find((entry) => entry.target === 'aw.command-set' && entry.id === `command-set.${set.set}`);
      if (!artifact || artifact.target !== 'aw.command-set') throw new Error(`commandReferenceInvalid: dynamic command set ${set.set} was not prepared.`);
      return { set: set.set, state: artifact.state, entries: artifact.entries };
    });
  return options.requestedSetNames === undefined ? requested : [
    ...(options.previousSets ?? []).filter((set) => !options.requestedSetNames!.has(set.set)),
    ...requested,
  ];
}

export async function prepareManagedCommandPackage(options: {
  plugin: PluginMeta; packageKey: string; scope: Scope; cwd: string; env: NodeJS.ProcessEnv;
  event?: 'install' | 'refresh' | 'materialize'; changedConfigKeys?: string[];
  requestedArtifactIds?: readonly string[];
}): Promise<PreparedManagedCommandPackage> {
  const declaration = options.plugin.manifest.managedCommands?.packages.find((entry) => entry.key === options.packageKey);
  if (!declaration || declaration.scope !== options.scope) throw new ManagedCommandError('commandDefinitionInvalid', 'The requested package and scope are not declared.');
  const renderConfig = await resolveArtifactRenderConfig({
    sourceId: options.plugin.sourceId, sourceIdentity: options.plugin.sourceIdentity,
    logicalIdentity: options.plugin.catalogLogicalIdentity, pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest, scope: declaration.scope, cwd: options.cwd, env: options.env,
  });
  if (renderConfig.issues.length > 0) throw new ManagedCommandError('commandDefinitionInvalid', 'Resolve the plugin configuration issues before refreshing its command package.');
  const producerRef = { kind: 'package' as const, packageKey: declaration.key };
  const producer = await managedCommandProducerIdentity({ ...options, producer: producerRef });
  const allTargets = getManagedCommandArtifactTargets(options.plugin.manifest).filter((target) =>
    target.producer.kind === 'package' && target.producer.packageKey === declaration.key);
  const explicitSubset = options.requestedArtifactIds !== undefined;
  const requestedIds = new Set(options.requestedArtifactIds);
  if (explicitSubset && (requestedIds.size === 0 || requestedIds.size !== options.requestedArtifactIds!.length || [...requestedIds].some((id) => !allTargets.some((target) => target.id === id)))) {
    throw new ManagedCommandError('commandDefinitionInvalid', 'A partial package request must contain unique declared targets of this producer.');
  }
  const targets = explicitSubset ? allTargets.filter((target) => requestedIds.has(target.id)) : allTargets;
  const requestedSetNames = explicitSubset ? new Set(targets.flatMap((target) => target.set ? [target.set] : [])) : undefined;
  let previous: { resourceRoot: string; sets: InstalledCommandSet[] } | undefined;
  if (explicitSubset) {
    const installed = (await listManagedCommandPackages(options.env)).packages.find((entry) => entry.id === getCommandPackageId(producer));
    if (installed) {
      if (installed.availability === 'unavailable') throw new ManagedCommandError('commandBindingInvalid', 'Partial refresh requires a verified installed command package. Run a complete package sync.');
      const record = await readInstalledCommandProducer(installed.resourceRoot);
      if (!sameProducer(record.producer, producer)) throw new ManagedCommandError('commandIdentityConflict', 'The installed command package belongs to another producer.');
      previous = { resourceRoot: installed.resourceRoot, sets: record.sets };
    }
    const hasUnrequestedSets = (options.plugin.manifest.managedCommands?.sets ?? []).some((set) => set.producer.kind === 'package' && set.producer.packageKey === declaration.key && !requestedSetNames!.has(set.set));
    if (!previous && (hasUnrequestedSets || (declaration.render && !targets.some((target) => target.target === 'aw.command-package')))) throw new ManagedCommandError('commandBindingInvalid', 'Partial refresh cannot reconstruct unrequested producer content. Run a complete package sync.');
  }
  let artifacts: ValidatedArtifactPlanArtifact[] = [];
  let generatedFiles: Record<string, string> = {};
  if (targets.length > 0) {
    const rendered = await runArtifactRenderer({ plugin: options.plugin, event: options.event ?? 'install', platform: 'managed-commands', scope: declaration.scope, cwd: options.cwd, commandEnv: options.env, requestedArtifactIds: targets.map((target) => target.id), ...(options.event === 'refresh' ? { changedConfigKeys: options.changedConfigKeys ?? [] } : {}) });
    artifacts = validateArtifactPlan({ manifest: options.plugin.manifest, plan: rendered.plan, platform: 'managed-commands', scope: declaration.scope, requestedArtifactIds: rendered.context.requestedArtifactIds, renderConfig: rendered.context.config, rendererDigest: rendered.target.rendererDigest, manifestDigest: rendered.target.manifestDigest }).artifacts;
    for (const artifact of artifacts) if (artifact.target === 'aw.command-package') generatedFiles = artifact.files;
  }
  const sets = commandSetsForProducer({ plugin: options.plugin, producer: producerRef, artifacts, ...(requestedSetNames ? { requestedSetNames, previousSets: previous?.sets } : {}) });
  let source = await resolveCommandSourceDirectory({ bundleRoot: options.plugin.rootDir, pluginRelativePath: declaration.sourceDir });
  let temporarySource: string | undefined;
  try {
    if (previous && !targets.some((target) => target.target === 'aw.command-package')) {
      temporarySource = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-command-previous-'));
      source = path.join(temporarySource, 'resource');
      await fs.copy(previous.resourceRoot, source, { dereference: false, errorOnExist: true });
      await fs.remove(path.join(source, '.aw-command-producer.json'));
    }
    const prepared = await prepareManagedCommandPackageFiles({ sourceRoot: source, files: generatedFiles, entries: sets.flatMap((set) => set.entries) });
    return { producer, sets, ...prepared };
  } finally { if (temporarySource) await fs.remove(temporarySource); }
}

export async function syncPluginManagedCommandPackage(options: {
  plugin: PluginMeta; packageKey: string; scope: Scope; cwd: string; env: NodeJS.ProcessEnv;
  event?: 'install' | 'refresh' | 'materialize'; changedConfigKeys?: string[];
  requestedArtifactIds?: readonly string[];
  managedCommandProducerCache?: Map<string, Promise<CommandProducerResult>>;
}): Promise<CommandProducerResult> {
  const producer = await managedCommandProducerIdentity({ ...options, producer: { kind: 'package', packageKey: options.packageKey } });
  const key = getCommandPackageId(producer);
  let result = options.managedCommandProducerCache?.get(key);
  if (!result) {
    result = (async () => {
      let candidate: PreparedManagedCommandPackage | undefined;
      try {
        candidate = await prepareManagedCommandPackage(options);
        const old = await listManagedCommandPackages(options.env);
        const previousIds = old.packages.find((entry) => entry.id === key)?.sets.flatMap((set) => set.commandIds) ?? [];
        const synced = await syncManagedCommandPackage({ producer, sourceDirectory: candidate.resourceRoot, sets: candidate.sets, env: options.env });
        return { producer, state: 'completed' as const, commandIds: synced.commandIds, removedCommandIds: previousIds.filter((id) => !synced.commandIds.includes(id)), errors: [], recoveryActions: [] };
      } catch (error) {
        return { producer, state: 'failed' as const, commandIds: [], removedCommandIds: [], errors: [managedCommandDiagnostic(error)], recoveryActions: [`aw command package sync ${producer.sourceId}/${producer.pluginName} ${producer.key} --scope ${producer.scope} --yes`] };
      } finally { await candidate?.cleanup(); }
    })();
    options.managedCommandProducerCache?.set(key, result);
  }
  return result;
}

export async function discoverInstalledPluginManagedCommandPackages(options: {
  plugin: PluginMeta; scope: Scope; cwd: string; env: NodeJS.ProcessEnv;
  platformTargets?: readonly Pick<ReceiptTargetIdentity, 'platform' | 'scope'>[];
}): Promise<ManagedCommandPackageDiscovery> {
  const listed = await listManagedCommandPackages(options.env);
  let currentProject: string | undefined;
  const relevant = listed.packages.filter((entry) => entry.producer.sourceId === options.plugin.sourceId && entry.producer.pluginName === options.plugin.manifest.name);
  const installedPackageIds = new Set(relevant.map((entry) => entry.id));
  const errors = [...listed.errors];
  if (relevant.some((entry) => entry.producer.scope === 'project') || (options.platformTargets?.length && options.plugin.manifest.managedCommands?.packages.some((entry) => entry.scope === 'project'))) currentProject = path.normalize(await fs.realpath(await resolveCanonicalRepoProjectKey(options.cwd)));
  const producers = new Map<string, ProducerIdentity>();
  for (const entry of relevant) {
    const identity = entry.producer;
    if (identity.scope === 'user' ? options.scope !== 'user' : identity.projectRoot !== currentProject) continue;
    if (identity.sourceIdentity !== options.plugin.sourceIdentity) {
      errors.push({ code: 'commandSourceIdentityChanged', message: `The retained command package belongs to a previous source identity; remove it with aw command package remove ${entry.id} --yes.`, subject: entry.id });
      continue;
    }
    producers.set(entry.id, identity);
  }
  for (const declaration of options.plugin.manifest.managedCommands?.packages ?? []) {
    if (options.scope === 'project' && declaration.scope !== 'project') continue;
    if (!options.platformTargets?.some((target) => declaration.platforms.includes(target.platform))) continue;
    const producer = await managedCommandProducerIdentity({ ...options, producer: { kind: 'package', packageKey: declaration.key } });
    producers.set(getCommandPackageId(producer), producer);
  }
  return { packages: [...producers].map(([packageId, producer]) => {
    const declaration = options.plugin.manifest.managedCommands?.packages.find((entry) => entry.key === producer.key && entry.scope === producer.scope);
    const setKeys = (options.plugin.manifest.managedCommands?.sets ?? []).flatMap((set) => set.producer.kind === 'package' && set.producer.packageKey === producer.key && set.mode === 'dynamic' ? set.refreshKeys : []);
    return { producer, packageId, packageKey: producer.key, refreshKeys: [...new Set([...(declaration?.refreshKeys ?? []), ...setKeys])], declared: declaration !== undefined, installed: installedPackageIds.has(packageId) };
  }), errors };
}

export async function createManagedCommandReferenceResolver(options: {
  plugin: PluginMeta; platform: PlatformName; scope: Scope; cwd: string; env: NodeJS.ProcessEnv;
  candidates?: readonly ManagedCommandCandidate[];
}): Promise<(reference: ManagedCommandReference) => string> {
  const resolved = new Map<string, string>();
  for (const set of options.plugin.manifest.managedCommands?.sets ?? []) {
    if (set.producer.kind === 'static-skill' && set.producer.platform !== options.platform) continue;
    if (set.producer.kind === 'package') {
      const declaration = options.plugin.manifest.managedCommands?.packages.find((entry) => set.producer.kind === 'package' && entry.key === set.producer.packageKey);
      if (!declaration?.platforms.includes(options.platform) || (options.scope === 'user' && declaration.scope === 'project')) continue;
    } else if (set.producer.kind === 'artifact') {
      const declaration = options.plugin.manifest.artifacts?.targets?.find((entry) => set.producer.kind === 'artifact' && entry.id === set.producer.artifactId);
      if (declaration?.platform !== options.platform || (options.scope === 'user' && declaration.delivery?.mode !== 'codex-native' && !declaration.scopes.includes('user'))) continue;
    }
    const producer = await managedCommandProducerIdentity({ ...options, producer: set.producer });
    if (producer.platform && producer.platform !== options.platform) continue;
    if (options.scope === 'user' && producer.scope === 'project') continue;
    if (set.producer.kind === 'package') {
      const declaration = options.plugin.manifest.managedCommands?.packages.find((entry) => entry.key === producer.key);
      if (!declaration?.platforms.includes(options.platform)) continue;
    }
    const candidate = [...(options.candidates ?? [])].reverse().find((entry) => sameProducer(entry.producer, producer));
    const entries = candidate?.sets.find((entry) => entry.set === set.set);
    if (candidate) {
      if (entries?.state !== 'present') continue;
      for (const entry of entries.entries) resolved.set(`${set.set}/${entry.key}/${entry.variant}`, getPluginCommandId({ schemaVersion: 1, producer, set: set.set, key: entry.key, variant: entry.variant }));
    } else if (set.mode === 'static') {
      for (const entry of set.entries) {
        const id = getPluginCommandId({ schemaVersion: 1, producer, set: set.set, key: entry.key, variant: entry.variant });
        if ((await inspectManagedCommand(id, options.env)).availability === 'ready') resolved.set(`${set.set}/${entry.key}/${entry.variant}`, id);
      }
    } else {
      const installed = await listManagedCommands(options.env);
      for (const command of installed.commands) if (command.availability === 'ready' && command.owner.kind === 'plugin' && sameProducer(command.owner.producer, producer) && command.name.startsWith(`${set.set}/`)) resolved.set(command.name, command.id);
    }
  }
  return (reference) => {
    if (!options.plugin.manifest.requires?.aw.capabilities?.includes('aw.managed-commands.v1')) throw new Error('commandReferenceInvalid: managed command references require aw.managed-commands.v1.');
    const id = resolved.get(`${reference.set}/${reference.key}/${reference.variant ?? 'default'}`);
    if (!id) throw new Error(`commandReferenceInvalid: command ${reference.set}/${reference.key}/${reference.variant ?? 'default'} has no verified producer for this consumer.`);
    return id;
  };
}

export function resolveSkillManagedCommandReferences(tree: DynamicSkillTree, resolve: (reference: ManagedCommandReference) => string): void {
  for (const [relative, content] of Object.entries(tree.files)) if (relative.endsWith('.md')) tree.files[relative] = Buffer.from(replaceManagedCommandPlaceholders(content.toString('utf8'), resolve), 'utf8');
}
